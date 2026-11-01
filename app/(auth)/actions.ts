"use server"

import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"

import { audit } from "@/lib/server/audit"
import { getCurrentUser, hasAnyUser } from "@/lib/server/auth/dal"
import {
  DEVICE_COOKIE,
  PENDING_2FA_COOKIE,
  PENDING_2FA_TTL_SECONDS,
  signPending2fa,
  verifyDevice,
  verifyPending2fa,
} from "@/lib/server/auth/flow-tokens"
import { passwordLoginAllowed } from "@/lib/server/auth/oidc"
import { getDummyHash, hashPassword, PasswordBusyError, verifyPassword } from "@/lib/server/auth/password"
import { destroySession, setAuthCookie, signIn } from "@/lib/server/auth/session"
import { verifySecondFactor } from "@/lib/server/auth/two-factor"
import { getDb } from "@/lib/server/db"
import { checkRateLimit, clearFailures, recordFailure } from "@/lib/server/rate-limit"
import {
  auditedLoginName,
  clientAddress,
  LOGIN_WINDOW_MS,
  loginRateKeys,
  shouldAuditFailure,
  TWO_FACTOR_LIMIT,
} from "@/lib/server/login-limits"
import { config } from "@/lib/server/config"
import { getI18n } from "@/lib/i18n/server"
import { safeNext } from "@/lib/safe-redirect"
import { clearSetupToken, verifySetupToken } from "@/lib/server/setup-token"
import { invalidateSessions } from "@/lib/server/users"
import {
  fieldErrors,
  passwordSchema,
  usernameSchema,
  type ActionState,
} from "@/lib/validation"


const SETUP_LIMIT = 20
/** Failed-login audit rows written per minute at most, whatever the accounts. */
const FAILED_LOGIN_AUDITS_PER_MINUTE = 30

/** Audits a failed attempt unless the log already got enough of them. */
async function auditFailure(action: string, target: string, count: number, limit: number) {
  if (!shouldAuditFailure(count, limit)) return
  if (recordFailure("audit:auth-failures", 60_000) > FAILED_LOGIN_AUDITS_PER_MINUTE) return
  await audit(null, action, count >= limit ? `${target} (locked for now)` : target)
}

export async function login(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const values = { username: String(formData.get("username") ?? "").slice(0, 64) }
  const parsed = z
    .object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) })
    .safeParse({ username: formData.get("username"), password: formData.get("password") })
  if (!parsed.success) return { error: t.auth.errors.enterCredentials, values }

  const { username, password } = parsed.data
  const db = await getDb()
  const user = await db
    .selectFrom("users")
    .select(["id", "username", "role", "password_hash", "totp_enabled"])
    .where("username", "=", username)
    .executeTakeFirst()

  // A browser that completed a login for this account before has its own bucket.
  const device = await verifyDevice((await cookies()).get(DEVICE_COOKIE)?.value)
  const deviceId = device && user && device.uid === user.id ? device.id : null
  const limits = loginRateKeys(username, clientAddress(await headers(), config.trustProxy), deviceId)
  const wait = Math.max(...limits.map((l) => checkRateLimit(l.key, l.limit)))
  if (wait > 0) return { error: format(t.auth.errors.tooManyAttempts, { seconds: wait }), values }

  let valid: boolean
  try {
    valid = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()))
  } catch (err) {
    if (err instanceof PasswordBusyError) return { error: t.auth.errors.passwordBusy, values }
    throw err
  }
  if (!user || !valid) {
    const counts = limits.map((l) => recordFailure(l.key, LOGIN_WINDOW_MS))
    await auditFailure("auth.login_failed", auditedLoginName(username, Boolean(user)), counts[0], limits[0].limit)
    return { error: t.auth.errors.invalidCredentials, values }
  }

  for (const l of limits) clearFailures(l.key)
  const next = safeNext(formData.get("next"))
  if (!passwordLoginAllowed(user.role)) {
    await audit({ id: user.id, username: user.username }, "auth.login_refused", "password sign-in is limited to administrators")
    return { error: t.auth.errors.ssoOnly, values }
  }

  if (Number(user.totp_enabled) === 1) {
    // Not a session yet: only proves the password for a few minutes.
    await setAuthCookie(PENDING_2FA_COOKIE, await signPending2fa({ uid: user.id, next }), PENDING_2FA_TTL_SECONDS)
    redirect("/login/two-factor")
  }

  await signIn(user.id)
  await audit({ id: user.id, username: user.username, role: user.role }, "auth.login", user.username)
  redirect(next)
}

/** Second login step: a TOTP code or a recovery code for the user whose password was just accepted. */
export async function verifyLoginCode(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const jar = await cookies()
  const pending = await verifyPending2fa(jar.get(PENDING_2FA_COOKIE)?.value)
  if (!pending) return { error: t.auth.errors.pendingExpired }

  const code = String(formData.get("code") ?? "").trim().slice(0, 32)
  if (!code) return { error: t.auth.errors.enterCode, fieldErrors: { code: [t.auth.errors.enterCode] } }

  const key = `2fa:${pending.uid}`
  const wait = checkRateLimit(key, TWO_FACTOR_LIMIT)
  if (wait > 0) return { error: format(t.auth.errors.tooManyAttempts, { seconds: wait }) }

  const db = await getDb()
  const user = await db.selectFrom("users").select(["id", "username", "role"]).where("id", "=", pending.uid).executeTakeFirst()
  const check = user ? await verifySecondFactor(db, user.id, code) : { ok: false as const }
  if (!user || !check.ok) {
    const count = recordFailure(key, LOGIN_WINDOW_MS)
    await auditFailure("auth.2fa_failed", user?.username ?? "(deleted user)", count, TWO_FACTOR_LIMIT)
    return { error: t.auth.errors.invalidCode, fieldErrors: { code: [t.auth.errors.invalidCode] } }
  }

  clearFailures(key)
  jar.delete(PENDING_2FA_COOKIE)
  await signIn(user.id)
  const actor = { id: user.id, username: user.username, role: user.role }
  if (check.method === "recovery") await audit(actor, "auth.2fa_recovery_used", user.username)
  await audit(actor, "auth.login", `${user.username} (2FA)`)
  redirect(safeNext(pending.next))
}

/** Abandons a pending two-factor login. */
export async function cancelTwoFactor() {
  ;(await cookies()).delete(PENDING_2FA_COOKIE)
  redirect("/login")
}

export async function setupAdmin(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  // Echo the token too, so a password typo doesn't mean digging it out again.
  const values = {
    username: String(formData.get("username") ?? "").slice(0, 64),
    token: String(formData.get("token") ?? "").slice(0, 128),
  }
  const parsed = z
    .object({ username: usernameSchema, password: passwordSchema, confirm: z.string() })
    .refine((d) => d.password === d.confirm, { path: ["confirm"], message: t.auth.errors.passwordsMismatch })
    .safeParse({
      username: formData.get("username"),
      password: formData.get("password"),
      confirm: formData.get("confirm"),
    })
  if (!parsed.success) return { ...fieldErrors(parsed.error), values }

  // The first account can only be created while no user exists, and only by
  // someone who can read the server log / data directory (the setup token).
  if (await hasAnyUser()) return { error: t.auth.errors.alreadySetUp }
  // The token is checked before the limit: it has far too much entropy to be
  // guessed, so the limit only slows down noise and never locks out the
  // person who has the real token.
  if (!verifySetupToken(String(formData.get("token") ?? ""))) {
    const count = recordFailure("setup", LOGIN_WINDOW_MS)
    await auditFailure("auth.setup_failed", "invalid setup token", count, SETUP_LIMIT)
    const wait = checkRateLimit("setup", SETUP_LIMIT)
    if (wait > 0) return { error: format(t.auth.errors.tooManyAttempts, { seconds: wait }), values }
    return { error: t.auth.errors.invalidSetupToken, fieldErrors: { token: [t.auth.errors.invalidSetupToken] }, values }
  }

  const db = await getDb()
  const result = await db
    .insertInto("users")
    .values({
      username: parsed.data.username,
      password_hash: await hashPassword(parsed.data.password),
      role: "admin",
      created_at: new Date().toISOString(),
    })
    .executeTakeFirstOrThrow()

  const id = Number(result.insertId)
  clearSetupToken()
  clearFailures("setup")
  await signIn(id)
  await audit({ id, username: parsed.data.username, role: "admin" }, "auth.setup", parsed.data.username)
  redirect("/dashboard")
}

export async function logout() {
  const user = await getCurrentUser()
  if (user) await audit(user, "auth.logout", user.username)
  await destroySession()
  redirect("/login")
}

/** Ends every session of the signed-in user, in all browsers (API tokens stay valid). */
export async function logoutEverywhere() {
  const user = await getCurrentUser()
  if (user?.via === "session") {
    await invalidateSessions(await getDb(), user.id)
    await audit(user, "auth.logout_everywhere", user.username)
  }
  await destroySession()
  redirect("/login")
}
