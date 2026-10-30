import "server-only"

import { cookies, headers } from "next/headers"

import { config } from "@/lib/server/config"
import { DEVICE_COOKIE, DEVICE_TTL_SECONDS, signDevice } from "@/lib/server/auth/flow-tokens"
import { SESSION_COOKIE, signSession, type SessionPayload } from "@/lib/server/auth/token"
import { getDb } from "@/lib/server/db"

/** `fallback`: what to assume when the request says nothing (e.g. a top-level GET without Origin). */
async function shouldUseSecureCookie(fallback = false) {
  if (config.cookieSecure === "true") return true
  if (config.cookieSecure === "false") return false
  const h = await headers()
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim()
  if (proto) return proto === "https"
  const origin = h.get("origin")
  return origin ? origin.startsWith("https://") : fallback
}

/** Sets an httpOnly, SameSite=Lax cookie with Gantry's Secure policy. */
export async function setAuthCookie(name: string, value: string, maxAgeSeconds: number, secureFallback?: boolean) {
  ;(await cookies()).set(name, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: await shouldUseSecureCookie(secureFallback),
    maxAge: maxAgeSeconds,
  })
}

export async function createSession(payload: SessionPayload, secureFallback?: boolean) {
  await setAuthCookie(SESSION_COOKIE, await signSession(payload), config.sessionTtlHours * 60 * 60, secureFallback)
}

/**
 * Completes a login: a session with the user's current role and session
 * version, plus a device cookie that keeps this browser from being locked out
 * by failed logins elsewhere (lib/server/login-limits.ts).
 */
export async function signIn(userId: number, secureFallback?: boolean) {
  const db = await getDb()
  const user = await db
    .selectFrom("users")
    .select(["id", "role", "session_version"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow()
  await createSession({ uid: user.id, role: user.role, ver: Number(user.session_version) }, secureFallback)
  await setAuthCookie(DEVICE_COOKIE, await signDevice(user.id), DEVICE_TTL_SECONDS, secureFallback)
}

export async function destroySession() {
  ;(await cookies()).delete(SESSION_COOKIE)
}
