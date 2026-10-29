import "server-only"

import { cache } from "react"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"

import { getDb } from "@/lib/server/db"
import type { Role } from "@/lib/server/db/schema"
import { SESSION_COOKIE, verifySession } from "@/lib/server/auth/token"

export type CurrentUser = {
  id: number
  username: string
  role: Role
}

/**
 * Data Access Layer entry point. proxy.ts only does the cheap signature
 * check; this re-reads the user so deleted users and role changes take
 * effect immediately. Deduplicated per request.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  const session = await verifySession(token)
  if (!session) return null

  const db = await getDb()
  const user = await db
    .selectFrom("users")
    .select(["id", "username", "role"])
    .where("id", "=", session.uid)
    .executeTakeFirst()
  return user ?? null
})

/** For pages: redirects to /login when there is no valid session. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser()
  if (!user) redirect("/login")
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
