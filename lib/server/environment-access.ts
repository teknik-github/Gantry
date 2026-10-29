import "server-only"

import type { Kysely } from "kysely"

import type { Database, Environment, Role } from "@/lib/server/db/schema"

// Per-environment access rules, kept free of request APIs (cookies, cache)
// so they can be tested directly. lib/server/environments.ts applies them to
// the signed-in user.
//
// - administrators can see and use every environment;
// - standard users only the ones granted in environment_access.

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

/** Replaces the set of environments a standard user may use. Unknown ids are ignored. */
export async function setUserEnvironments(db: Kysely<Database>, userId: number, environmentIds: number[]) {
  const wanted = [...new Set(environmentIds)]
  await db.transaction().execute(async (trx) => {
    const ids = wanted.length
      ? (await trx.selectFrom("environments").select("id").where("id", "in", wanted).execute()).map((r) => r.id)
      : []
    await trx.deleteFrom("environment_access").where("user_id", "=", userId).execute()
    if (ids.length) {
      const now = new Date().toISOString()
      await trx
        .insertInto("environment_access")
        .values(ids.map((environment_id) => ({ user_id: userId, environment_id, created_at: now })))
        .execute()
    }
  })
}

/** Replaces the set of standard users who may use an environment. Unknown ids and admins are ignored. */
export async function setEnvironmentUsers(db: Kysely<Database>, environmentId: number, userIds: number[]) {
  const wanted = [...new Set(userIds)]
  await db.transaction().execute(async (trx) => {
    const ids = wanted.length
      ? (
          await trx.selectFrom("users").select("id").where("id", "in", wanted).where("role", "=", "user").execute()
        ).map((r) => r.id)
      : []
    await trx.deleteFrom("environment_access").where("environment_id", "=", environmentId).execute()
    if (ids.length) {
      const now = new Date().toISOString()
      await trx
        .insertInto("environment_access")
        .values(ids.map((user_id) => ({ user_id, environment_id: environmentId, created_at: now })))
        .execute()
    }
  })
}

/** All grants of standard users with their usernames, for the admin screens. */
export async function listGrants(db: Kysely<Database>) {
  return db
    .selectFrom("environment_access")
    .innerJoin("users", "users.id", "environment_access.user_id")
    .select(["environment_access.user_id", "environment_access.environment_id", "users.username"])
    .where("users.role", "=", "user")
    .orderBy("users.username")
    .execute()
}
