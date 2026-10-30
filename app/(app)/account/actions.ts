"use server"

import { redirect } from "next/navigation"
import { renderSVG } from "uqr"
import { z } from "zod"

import { authorize, runAction, UserError } from "@/lib/server/action"
import { createApiToken, listApiTokens, MAX_TOKENS_PER_USER, revokeApiToken } from "@/lib/server/auth/api-tokens"
import { beginOidc } from "@/lib/server/auth/oidc-flow"
import { hashPassword, PasswordBusyError, verifyPassword } from "@/lib/server/auth/password"
import { createSession } from "@/lib/server/auth/session"
import { otpauthUri } from "@/lib/server/auth/totp"
import {
  beginEnrolment,
  confirmEnrolment,
  disableTwoFactor,
  regenerateRecoveryCodes,
  verifySecondFactor,
} from "@/lib/server/auth/two-factor"
import { getDb } from "@/lib/server/db"
import { checkRateLimit, clearFailures, recordFailure } from "@/lib/server/rate-limit"
import { LOGIN_WINDOW_MS, TWO_FACTOR_LIMIT } from "@/lib/server/login-limits"
import { invalidateSessions, sessionVersion } from "@/lib/server/users"
import { fieldErrors, passwordSchema, type ActionState } from "@/lib/validation"

// Everything here acts on the signed-in user's own account ("user"
// permission: any role, browser session only).

/** Ends the user's other sessions and keeps this browser signed in. */
async function rotateSessions(user: { id: number; role: "admin" | "user" }) {
  const db = await getDb()
  await invalidateSessions(db, user.id)
  await createSession({ uid: user.id, role: user.role, ver: await sessionVersion(db, user.id) })
}

/** Checks the current password; wrong guesses count against a per-user limit. */
async function checkPassword(userId: number, password: string) {
  const key = `reauth:${userId}`
  const wait = checkRateLimit(key, TWO_FACTOR_LIMIT)
  if (wait > 0) throw new UserError(`Too many attempts. Try again in ${wait}s.`)
  const db = await getDb()
  const row = await db.selectFrom("users").select("password_hash").where("id", "=", userId).executeTakeFirstOrThrow()
  let ok: boolean
  try {
    ok = await verifyPassword(password, row.password_hash)
  } catch (err) {
    if (err instanceof PasswordBusyError) throw new UserError(err.message)
    throw err
  }
  if (!ok) {
    recordFailure(key, LOGIN_WINDOW_MS)
    throw new UserError("Current password is incorrect")
  }
  clearFailures(key)
}

/** Checks a TOTP or recovery code; failures are limited like the login's second step. */
async function checkCode(userId: number, code: string) {
  const key = `2fa:${userId}`
  const wait = checkRateLimit(key, TWO_FACTOR_LIMIT)
  if (wait > 0) throw new UserError(`Too many attempts. Try again in ${wait}s.`)
  const check = await verifySecondFactor(await getDb(), userId, code)
  if (!check.ok) {
    recordFailure(key, LOGIN_WINDOW_MS)
    throw new UserError("Invalid code")
  }
  clearFailures(key)
  return check
}

export async function changePassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ current: z.string().min(1, "Enter your current password"), password: passwordSchema, confirm: z.string() })
    .refine((d) => d.password === d.confirm, { path: ["confirm"], message: "Passwords do not match" })
    .safeParse(Object.fromEntries(formData))
  if (!parsed.success) return fieldErrors(parsed.error)

  return runAction("user", "account.change_password", "self", async ({ user }) => {
    await checkPassword(user.id, parsed.data.current)
    const db = await getDb()
    await db
      .updateTable("users")
      .set({ password_hash: await hashPassword(parsed.data.password) })
      .where("id", "=", user.id)
      .execute()
    // Anyone who knew the old password is signed out; this browser stays in.
    await rotateSessions(user)
    return "Password changed. Your other sessions were signed out."
  })
}

// ------------------------------------------------------------- Two-factor

export type EnrolmentState = ActionState & {
  /** Shown once while enrolling; never sent again once 2FA is on. */
  secret?: string
  uri?: string
  qrSvg?: string
}

/** Step 1: password → a new secret as otpauth:// URI and QR code. 2FA stays off until a code is confirmed. */
export async function startTwoFactor(_prev: EnrolmentState, formData: FormData): Promise<EnrolmentState> {
  const password = String(formData.get("password") ?? "")
  if (!password) return { error: "Enter your password", fieldErrors: { password: ["Enter your password"] } }
  const auth = await authorize("user")
  if ("error" in auth) return auth
  const { user } = auth
  try {
    await checkPassword(user.id, password)
  } catch (err) {
    if (err instanceof UserError) return { error: err.message, fieldErrors: { password: [err.message] } }
    throw err
  }
  const secret = await beginEnrolment(await getDb(), user.id)
  if (!secret) return { error: "Two-factor authentication is already on" }
  const uri = otpauthUri(secret, user.username)
  return { ok: true, secret, uri, qrSvg: renderSVG(uri, { border: 2 }) }
}

export type RecoveryCodesState = ActionState & { recoveryCodes?: string[] }

/** Step 2: a code from the app turns 2FA on; the recovery codes are returned once. */
export async function confirmTwoFactor(_prev: RecoveryCodesState, formData: FormData): Promise<RecoveryCodesState> {
  const code = String(formData.get("code") ?? "").trim().slice(0, 32)
  let recoveryCodes: string[] | undefined
  const res = await runAction("user", "account.2fa_enable", "self", async ({ user }) => {
    const key = `2fa-enrol:${user.id}`
    const wait = checkRateLimit(key, TWO_FACTOR_LIMIT)
    if (wait > 0) throw new UserError(`Too many attempts. Try again in ${wait}s.`)
    const codes = await confirmEnrolment(await getDb(), user.id, code)
    if (!codes) {
      recordFailure(key, LOGIN_WINDOW_MS)
      throw new UserError("That code doesn't match. Check the time on your device and enter the current code.")
    }
    clearFailures(key)
    recoveryCodes = codes
    await rotateSessions(user)
    return "Two-factor authentication is on"
  })
  return res.ok ? { ...res, recoveryCodes } : { ...res, fieldErrors: { code: [res.error ?? "Invalid code"] } }
}

/** Turns 2FA off: needs the password and a current (or recovery) code. */
export async function disableTwoFactorAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const password = String(formData.get("password") ?? "")
  const code = String(formData.get("code") ?? "").trim().slice(0, 32)
  if (!password || !code) return { error: "Enter your password and a code" }
  return runAction("user", "account.2fa_disable", "self", async ({ user }) => {
    await checkPassword(user.id, password)
    await checkCode(user.id, code)
    await disableTwoFactor(await getDb(), user.id)
    await rotateSessions(user)
    return "Two-factor authentication is off"
  })
}

/** New recovery codes (password + code); the old ones stop working. */
export async function regenerateRecoveryCodesAction(_prev: RecoveryCodesState, formData: FormData): Promise<RecoveryCodesState> {
  const password = String(formData.get("password") ?? "")
  const code = String(formData.get("code") ?? "").trim().slice(0, 32)
  if (!password || !code) return { error: "Enter your password and a code" }
  let recoveryCodes: string[] | undefined
  const res = await runAction("user", "account.2fa_recovery_codes", "self", async ({ user }) => {
    await checkPassword(user.id, password)
    await checkCode(user.id, code)
    recoveryCodes = (await regenerateRecoveryCodes(await getDb(), user.id)) ?? undefined
    if (!recoveryCodes) throw new UserError("Two-factor authentication is off")
    return "New recovery codes created"
  })
  return { ...res, recoveryCodes }
}

// ------------------------------------------------------------- API tokens

const EXPIRY_DAYS = { "30": 30, "90": 90, "365": 365, never: null } as const
export type TokenExpiry = keyof typeof EXPIRY_DAYS

export type TokenState = ActionState & { token?: string }

/** Creates a personal API token; the value is returned once and only its hash is kept. */
export async function createToken(_prev: TokenState, formData: FormData): Promise<TokenState> {
  const values = { name: String(formData.get("name") ?? "").slice(0, 64), expires: String(formData.get("expires") ?? "90") }
  const parsed = z
    .object({
      name: z
        .string()
        .trim()
        .min(1, "Name is required")
        .max(64, "At most 64 characters")
        .regex(/^[\p{L}\p{N} _.:@()-]+$/u, "Letters, numbers, spaces and _.:@()-"),
      expires: z.enum(Object.keys(EXPIRY_DAYS) as [TokenExpiry, ...TokenExpiry[]]),
    })
    .safeParse(values)
  if (!parsed.success) return { ...fieldErrors(parsed.error), values }
  const { name, expires } = parsed.data

  let token: string | undefined
  const res = await runAction("user", "account.token_create", name, async ({ user }) => {
    const db = await getDb()
    if ((await listApiTokens(db, user.id)).length >= MAX_TOKENS_PER_USER) {
      throw new UserError(`At most ${MAX_TOKENS_PER_USER} tokens; revoke one first`)
    }
    const days = EXPIRY_DAYS[expires]
    token = await createApiToken(db, user.id, name, days ? new Date(Date.now() + days * 86_400_000) : null)
    return `Token ${name} created`
  })
  return { ...res, token, values }
}

export async function revokeToken(id: number): Promise<ActionState> {
  const parsed = z.number().int().positive().safeParse(id)
  if (!parsed.success) return { error: "Invalid token" }
  return runAction("user", "account.token_revoke", `#${parsed.data}`, async ({ user }) => {
    const name = await revokeApiToken(await getDb(), user.id, parsed.data)
    if (!name) throw new UserError("Token not found")
    return `Token ${name} revoked`
  })
}

// ------------------------------------------------------------- Single sign-on

/** Links the signed-in account to an SSO identity: sends the browser to the identity provider. */
export async function linkSso(): Promise<ActionState> {
  const auth = await authorize("user")
  if ("error" in auth) return auth
  let url: string
  try {
    url = await beginOidc({ next: "/account", linkUid: auth.user.id })
  } catch (err) {
    console.error(`[gantry] single sign-on unavailable: ${(err as Error).message}`)
    return { error: "Single sign-on is unavailable. Check the server logs." }
  }
  redirect(url)
}
