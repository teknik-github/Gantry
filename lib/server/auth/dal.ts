import "server-only"

import { cache } from "react"
import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"

import { authenticateApiToken, bearerToken } from "@/lib/server/auth/api-tokens"
import { safeEqual } from "@/lib/server/auth/oidc"
import { API_AUTH_HEADER, apiAuthMarker, SESSION_COOKIE, verifySession } from "@/lib/server/auth/token"
import { getDb } from "@/lib/server/db"
import type { Role } from "@/lib/server/db/schema"

export type CurrentUser = {
  id: number
  username: string
  role: Role
  /** "token": an API token on an /api/* route handler; "session": the browser cookie. */
  via: "session" | "token"
}

/**
 * Whether this request is an /api/* call carrying an API token, as marked by
 * proxy.ts. Server Actions are never token-authenticated: they are POSTs to
 * page URLs and rely on the cookie's SameSite and Next's origin check.
 */
function isTokenRequest(h: Headers) {
  const marker = h.get(API_AUTH_HEADER)
  return Boolean(marker && safeEqual(marker, apiAuthMarker()) && !h.has("next-action"))
}

/**
 * Data Access Layer entry point. proxy.ts only does the cheap signature
 * check; this re-reads the user so deleted users and role changes take
 * effect immediately. Deduplicated per request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const h = await headers()
  if (isTokenRequest(h)) {
    const token = bearerToken(h.get("authorization"))
    if (!token) return null
    const user = await authenticateApiToken(await getDb(), token)
    return user ? { ...user, via: "token" } : null
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const session = await verifySession(token)
  if (!session) return null

  const db = await getDb()
  const user = await db
    .selectFrom("users")
    .select(["id", "username", "role", "session_version"])
    .where("id", "=", session.uid)
    .executeTakeFirst()
  // Signed out everywhere (or password/role changed) since this session was made.
  if (!user || Number(user.session_version) !== session.ver) return null
  return { id: user.id, username: user.username, role: user.role, via: "session" }
})

/**
 * For pages: redirects to /login when there is no valid session. A cookie
 * that proxy.ts accepted (valid signature) but the DAL didn't (user deleted,
 * signed out everywhere) is cleared first by /auth/signout, otherwise proxy
 * would bounce /login straight back.
 */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) redirect((await cookies()).has(SESSION_COOKIE) ? "/auth/signout" : "/login")
  return user
}

/** For admin-only pages: non-admins are sent back to the dashboard. */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser()
  if (user.role !== "admin") redirect("/dashboard")
  return user
}

export async function hasAnyUser(): Promise<boolean> {
  const db = await getDb()
  const row = await db.selectFrom("users").select("id").limit(1).executeTakeFirst()
  return Boolean(row)
}
