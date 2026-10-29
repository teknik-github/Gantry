"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { z } from "zod"

import { audit } from "@/lib/server/audit"
import { getCurrentUser, hasAnyUser } from "@/lib/server/auth/dal"
import { getDummyHash, hashPassword, verifyPassword } from "@/lib/server/auth/password"
import { createSession, destroySession } from "@/lib/server/auth/session"
import { getDb } from "@/lib/server/db"
import { checkRateLimit, clearFailures, recordFailure } from "@/lib/server/rate-limit"
import { safeNext } from "@/lib/safe-redirect"
import {
  fieldErrors,
  passwordSchema,
  usernameSchema,
  type ActionState,
} from "@/lib/validation"

const LOGIN_LIMIT = 5
const LOGIN_WINDOW_MS = 5 * 60_000

async function clientIp() {
  const h = await headers()
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local"
}

export async function login(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = { username: String(formData.get("username") ?? "").slice(0, 64) }
  const parsed = z
    .object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) })
    .safeParse({ username: formData.get("username"), password: formData.get("password") })
  if (!parsed.success) return { error: "Enter your username and password", values }

  const { username, password } = parsed.data
  const key = `login:${await clientIp()}:${username.toLowerCase()}`
  const wait = checkRateLimit(key, LOGIN_LIMIT)
  if (wait > 0) return { error: `Too many attempts. Try again in ${wait}s.`, values }

  const db = await getDb()
  const user = await db
    .selectFrom("users")
    .selectAll()
    .where("username", "=", username)
    .executeTakeFirst()

  const valid = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()))
  if (!user || !valid) {
    recordFailure(key, LOGIN_WINDOW_MS)
    await audit(null, "auth.login_failed", username)
    return { error: "Invalid username or password", values }
  }

  clearFailures(key)
  await createSession({ uid: user.id, role: user.role })
  await audit({ id: user.id, username: user.username, role: user.role }, "auth.login", user.username)
  redirect(safeNext(formData.get("next")))
}

export async function setupAdmin(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = { username: String(formData.get("username") ?? "").slice(0, 64) }
  const parsed = z
    .object({ username: usernameSchema, password: passwordSchema, confirm: z.string() })
    .refine((d) => d.password === d.confirm, { path: ["confirm"], message: "Passwords do not match" })
    .safeParse({
      username: formData.get("username"),
      password: formData.get("password"),
      confirm: formData.get("confirm"),
    })
  if (!parsed.success) return { ...fieldErrors(parsed.error), values }

  // The first account can only be created while no user exists.
  if (await hasAnyUser()) return { error: "Gantry is already set up. Please sign in." }

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
  await createSession({ uid: id, role: "admin" })
  await audit({ id, username: parsed.data.username, role: "admin" }, "auth.setup", parsed.data.username)
  redirect("/dashboard")
}

export async function logout() {
  const user = await getCurrentUser()
  if (user) await audit(user, "auth.logout", user.username)
  await destroySession()
  redirect("/login")
}
