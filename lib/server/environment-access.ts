import "server-only"

import type { Kysely } from "kysely"

import { isEnvironmentRole, type EnvironmentRole } from "@/lib/permissions"
import type { Database, Environment, Role } from "@/lib/server/db/schema"

// Per-environment access rules, kept free of request APIs (cookies, cache)
// so they can be tested directly. lib/server/environments.ts applies them to
// the signed-in user.
//
// - administrators can see and use every environment, with every right;
// - standard users only the ones granted in environment_access, with the
//   role of the grant (viewer, operator or manager; see lib/permissions.ts).

/** A grant to save: the user or environment id and the role. */
export type Grant = { id: number; role: EnvironmentRole }

/** Environments the user may use, ordered by id. */
export async function environmentsForUser(
  db: Kysely<Database>,
  user: { id: number; role: Role }
): Promise<Environment[]> {
  if (user.role === "admin") {
    return db.selectFrom("environments").selectAll().orderBy("id").execute()
  }
  return db
    .selectFrom("environments")
    .innerJoin("environment_access", "environment_access.environment_id", "environments.id")
    .selectAll("environments")
    .where("environment_access.user_id", "=", user.id)
    .orderBy("environments.id")
    .execute()
}

/**
 * A standard user's role in an environment, null without a grant. Unknown
 * values stored in the database grant nothing. Administrators don't have
 * grants; check their global role first (lib/permissions.ts allows()).
 */
export async function environmentRoleFor(
  db: Kysely<Database>,
  userId: number,
  environmentId: number
): Promise<EnvironmentRole | null> {
  const row = await db
    .selectFrom("environment_access")
    .select("role")
    .where("user_id", "=", userId)
    .where("environment_id", "=", environmentId)
    .executeTakeFirst()
  return row && isEnvironmentRole(row.role) ? row.role : null
}

/** Last role wins for duplicate ids; invalid roles are dropped. */
function dedupe(grants: Grant[]) {
  const map = new Map<number, EnvironmentRole>()
  for (const g of grants) if (isEnvironmentRole(g.role)) map.set(g.id, g.role)
  return map
}

/** Replaces the environments (and roles) of a standard user. Unknown ids are ignored. */
export async function setUserEnvironments(db: Kysely<Database>, userId: number, grants: Grant[]) {
  const wanted = dedupe(grants)
  await db.transaction().execute(async (trx) => {
    const ids = wanted.size
      ? (await trx.selectFrom("environments").select("id").where("id", "in", [...wanted.keys()]).execute()).map((r) => r.id)
      : []
    await trx.deleteFrom("environment_access").where("user_id", "=", userId).execute()
    if (ids.length) {
      const now = new Date().toISOString()
      await trx
        .insertInto("environment_access")
        .values(ids.map((environment_id) => ({ user_id: userId, environment_id, role: wanted.get(environment_id)!, created_at: now })))
        .execute()
    }
  })
}

/** Replaces the standard users (and roles) of an environment. Unknown ids and admins are ignored. */
export async function setEnvironmentUsers(db: Kysely<Database>, environmentId: number, grants: Grant[]) {
  const wanted = dedupe(grants)
  await db.transaction().execute(async (trx) => {
    const ids = wanted.size
      ? (
          await trx
            .selectFrom("users")
            .select("id")
            .where("id", "in", [...wanted.keys()])
            .where("role", "=", "user")
            .execute()
        ).map((r) => r.id)
      : []
    await trx.deleteFrom("environment_access").where("environment_id", "=", environmentId).execute()
    if (ids.length) {
      const now = new Date().toISOString()
      await trx
        .insertInto("environment_access")
        .values(ids.map((user_id) => ({ user_id, environment_id: environmentId, role: wanted.get(user_id)!, created_at: now })))
        .execute()
    }
  })
}

/** All grants of standard users with their usernames, for the admin screens. */
export async function listGrants(db: Kysely<Database>) {
  const rows = await db
    .selectFrom("environment_access")
    .innerJoin("users", "users.id", "environment_access.user_id")
    .select(["environment_access.user_id", "environment_access.environment_id", "environment_access.role", "users.username"])
    .where("users.role", "=", "user")
    .orderBy("users.username")
    .execute()
  return rows.flatMap((r) => (isEnvironmentRole(r.role) ? [{ ...r, role: r.role }] : []))
}

/**
 * Parses grant form values "<id>:<role>" (e.g. "3:operator"). A bare id
 * means "operator", the role every grant had before roles existed.
 * Returns null when any value is malformed.
 */
export function parseGrants(values: unknown[]): Grant[] | null {
  const out: Grant[] = []
  for (const v of values) {
    if (typeof v !== "string") return null
    const [rawId, rawRole = "operator", ...rest] = v.split(":")
    const id = Number(rawId)
    if (rest.length || !/^\d+$/.test(rawId) || !Number.isSafeInteger(id) || id <= 0 || !isEnvironmentRole(rawRole)) return null
    out.push({ id, role: rawRole })
  }
  return out
}
