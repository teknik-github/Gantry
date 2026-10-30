import "server-only"

import { MysqlAdapter, type Kysely, type Transaction } from "kysely"

import type { Database, Role } from "@/lib/server/db/schema"
import { closeUserExecSessions } from "@/lib/server/docker/exec"

// Account changes that affect security, kept free of request APIs so they
// can be tested against a real database.

/**
 * Signs a user out everywhere: sessions carry users.session_version and
 * the DAL rejects older ones. Their open consoles are closed too. API tokens
 * are separate and stay valid until revoked.
 */
export async function invalidateSessions(db: Kysely<Database> | Transaction<Database>, userId: number) {
  await db
    .updateTable("users")
    .set((eb) => ({ session_version: eb("session_version", "+", 1) }))
    .where("id", "=", userId)
    .execute()
  closeUserExecSessions(userId)
}

/** Current session version of a user (for re-issuing the caller's own cookie after a bump). */
export async function sessionVersion(db: Kysely<Database>, userId: number): Promise<number> {
  const row = await db.selectFrom("users").select("session_version").where("id", "=", userId).executeTakeFirstOrThrow()
  return Number(row.session_version)
}

/**
 * Locks the administrator rows until the transaction ends, so two admins
 * demoting or deleting each other at the same time can't both pass the
 * "at least one administrator" check. SQLite runs transactions one at a time
 * on Gantry's single connection, MySQL needs the row locks.
 */
async function lockedAdminIds(trx: Transaction<Database>): Promise<number[]> {
  let q = trx.selectFrom("users").select("id").where("role", "=", "admin")
  if (trx.getExecutor().adapter instanceof MysqlAdapter) q = q.forUpdate()
  return (await q.execute()).map((r) => r.id)
}

export type UserChange = "ok" | "not_found" | "last_admin"

/**
 * Changes a user's global role atomically, never leaving Gantry without an
 * administrator. Promotion clears their environment grants (administrators
 * use every environment), so a later demotion starts from no access rather
 * than reviving old grants. Their sessions end: the new role applies at once.
 */
export async function changeRole(db: Kysely<Database>, userId: number, role: Role): Promise<UserChange> {
  const result = await db.transaction().execute(async (trx) => {
    const target = await trx.selectFrom("users").select("role").where("id", "=", userId).executeTakeFirst()
    if (!target) return "not_found" as const
    if (target.role === role) return "ok" as const
    if (role !== "admin") {
      const admins = await lockedAdminIds(trx)
      if (admins.length <= 1 && admins.includes(userId)) return "last_admin" as const
    }
    await trx.updateTable("users").set({ role }).where("id", "=", userId).execute()
    if (role === "admin") await trx.deleteFrom("environment_access").where("user_id", "=", userId).execute()
    await trx
      .updateTable("users")
      .set((eb) => ({ session_version: eb("session_version", "+", 1) }))
      .where("id", "=", userId)
      .execute()
    return "changed" as const
  })
  if (result === "changed") {
    closeUserExecSessions(userId)
    return "ok"
  }
  return result
}

/** Deletes a user atomically, never the last administrator. Grants, codes and tokens go with it (FK cascade). */
export async function deleteUserChecked(db: Kysely<Database>, userId: number): Promise<UserChange> {
  const result = await db.transaction().execute(async (trx) => {
    const target = await trx.selectFrom("users").select("role").where("id", "=", userId).executeTakeFirst()
    if (!target) return "not_found" as const
    if (target.role === "admin") {
      const admins = await lockedAdminIds(trx)
      if (admins.length <= 1) return "last_admin" as const
    }
    await trx.deleteFrom("users").where("id", "=", userId).execute()
    return "ok" as const
  })
  if (result === "ok") closeUserExecSessions(userId)
  return result
}
