import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Kysely, MysqlDialect, SqliteDialect, sql } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { migrationProvider } from "@/lib/server/db/migrations"
import type { Database } from "@/lib/server/db/schema"
import { openSqlite } from "@/lib/server/db/sqlite"
import {
  environmentRoleFor,
  environmentsForUser,
  listGrants,
  parseGrants,
  setEnvironmentUsers,
  setUserEnvironments,
} from "@/lib/server/environment-access"

// Runs the real migrations on SQLite, and on MySQL too when
// GANTRY_TEST_MYSQL_URL points at a throwaway database (it is wiped).

type Setup = { name: string; open: () => Promise<{ db: Kysely<Database>; cleanup: () => Promise<void> }> }

const setups: Setup[] = [
  {
    name: "sqlite",
    async open() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-b-db-"))
      const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: openSqlite(path.join(dir, "t.db")) }) })
      return {
        db,
        cleanup: async () => {
          await db.destroy()
          fs.rmSync(dir, { recursive: true, force: true })
        },
      }
    },
  },
]

const mysqlUrl = process.env.GANTRY_TEST_MYSQL_URL
if (mysqlUrl) {
  setups.push({
    name: "mysql",
    async open() {
      const { createPool } = await import("mysql2")
      const db = new Kysely<Database>({ dialect: new MysqlDialect({ pool: createPool({ uri: mysqlUrl, connectionLimit: 4 }) }) })
      for (const t of [
        "environment_access",
        "recovery_codes",
        "api_tokens",
        "audit_logs",
        "stacks",
        "metrics",
        "auto_update_rules",
        "alerts",
        "proxy_settings",
        "proxy_hosts",
        "registries",
        "templates",
        "notification_channels",
        "settings",
        "environments",
        "users",
        "kysely_migration",
        "kysely_migration_lock",
      ]) {
        await sql`drop table if exists ${sql.table(t)}`.execute(db)
      }
      return { db, cleanup: () => db.destroy() }
    },
  })
}

describe.each(setups)("environment access ($name)", { timeout: 300_000 }, ({ open }) => {
  let db: Kysely<Database>
  let cleanup: () => Promise<void>
  const ids = { admin: 0, alice: 0, bob: 0, local: 0, remote: 0 }
  const now = new Date().toISOString()

  async function addUser(username: string, role: "admin" | "user") {
    const r = await db.insertInto("users").values({ username, password_hash: "x", role, created_at: now }).executeTakeFirstOrThrow()
    return Number(r.insertId)
  }

  async function addEnv(name: string) {
    const r = await db
      .insertInto("environments")
      .values({ name, type: "tcp", url: `${name}:2375`, created_at: now })
      .executeTakeFirstOrThrow()
    return Number(r.insertId)
  }

  const names = async (user: { id: number; role: "admin" | "user" }) =>
    (await environmentsForUser(db, user)).map((e) => e.name)

  beforeAll(async () => {
    ;({ db, cleanup } = await open())
    const migrator = new Migrator({ db, provider: migrationProvider })
    // An install from before per-environment access: users and two environments.
    const first = await migrator.migrateTo("001_initial")
    expect(first.error).toBeUndefined()
    ids.admin = await addUser("root", "admin")
    ids.alice = await addUser("alice", "user")
    ids.bob = await addUser("bob", "user")
    ids.local = (await db.selectFrom("environments").select("id").executeTakeFirstOrThrow()).id
    ids.remote = Number(
      (await db.insertInto("environments").values({ name: "remote", type: "tcp", url: "remote:2375", created_at: now }).executeTakeFirstOrThrow())
        .insertId
    )
    const latest = await migrator.migrateToLatest()
    expect(latest.error).toBeUndefined()
  }, 900_000) // MySQL DDL can be very slow on a busy host

  afterAll(async () => {
    await cleanup?.()
  })

  it("adds the auth columns with safe defaults", async () => {
    const user = await db.selectFrom("users").selectAll().where("id", "=", ids.alice).executeTakeFirstOrThrow()
    expect(user).toMatchObject({ totp_secret: null, totp_last_step: null, oidc_issuer: null, oidc_subject: null })
    expect(Number(user.totp_enabled)).toBe(0)
    expect(Number(user.session_version)).toBe(0)
  })

  it("adds nullable TLS columns", async () => {
    const env = await db.selectFrom("environments").selectAll().where("id", "=", ids.remote).executeTakeFirstOrThrow()
    expect(env).toMatchObject({ tls_ca: null, tls_cert: null, tls_key: null })
    const long = "x".repeat(20_000)
    await db.updateTable("environments").set({ tls_ca: long, tls_cert: long, tls_key: long }).where("id", "=", ids.remote).execute()
    const back = await db.selectFrom("environments").select("tls_key").where("id", "=", ids.remote).executeTakeFirstOrThrow()
    expect(back.tls_key).toBe(long)
    await db.updateTable("environments").set({ tls_ca: null, tls_cert: null, tls_key: null }).where("id", "=", ids.remote).execute()
  })

  it("grants existing standard users every existing environment, as operator", async () => {
    const grants = await listGrants(db)
    expect(grants.map((g) => `${g.username}:${g.environment_id}:${g.role}`).sort()).toEqual(
      [
        `alice:${ids.local}:operator`,
        `alice:${ids.remote}:operator`,
        `bob:${ids.local}:operator`,
        `bob:${ids.remote}:operator`,
      ].sort()
    )
    expect(await environmentRoleFor(db, ids.alice, ids.local)).toBe("operator")
    expect(await environmentRoleFor(db, ids.admin, ids.local)).toBeNull()
  })

  it("lets administrators see every environment", async () => {
    expect(await names({ id: ids.admin, role: "admin" })).toEqual(["local", "remote"])
  })

  it("does not grant new environments automatically", async () => {
    await addEnv("staging")
    expect(await names({ id: ids.alice, role: "user" })).toEqual(["local", "remote"])
    expect(await names({ id: ids.admin, role: "admin" })).toEqual(["local", "remote", "staging"])
  })

  it("replaces a user's environments, ignoring unknown ids", async () => {
    const staging = (await db.selectFrom("environments").select("id").where("name", "=", "staging").executeTakeFirstOrThrow()).id
    await setUserEnvironments(db, ids.alice, [
      { id: staging, role: "viewer" },
      { id: staging, role: "manager" },
      { id: 999_999, role: "viewer" },
    ])
    expect(await names({ id: ids.alice, role: "user" })).toEqual(["staging"])
    // The last role given for an id wins.
    expect(await environmentRoleFor(db, ids.alice, staging)).toBe("manager")
    await setUserEnvironments(db, ids.alice, [])
    expect(await names({ id: ids.alice, role: "user" })).toEqual([])
    // A user's grants don't leak to another user.
    expect(await names({ id: ids.bob, role: "user" })).toEqual(["local", "remote"])
  })

  it("replaces an environment's users, ignoring administrators", async () => {
    await setEnvironmentUsers(db, ids.local, [
      { id: ids.alice, role: "viewer" },
      { id: ids.admin, role: "manager" },
    ])
    expect(await names({ id: ids.alice, role: "user" })).toEqual(["local"])
    expect(await environmentRoleFor(db, ids.alice, ids.local)).toBe("viewer")
    expect(await names({ id: ids.bob, role: "user" })).toEqual(["remote"])
    const grants = await db.selectFrom("environment_access").selectAll().where("user_id", "=", ids.admin).execute()
    expect(grants).toEqual([])
  })

  it("treats an unknown stored role as no access", async () => {
    await db.updateTable("environment_access").set({ role: "superuser" as never }).where("user_id", "=", ids.alice).execute()
    expect(await environmentRoleFor(db, ids.alice, ids.local)).toBeNull()
    expect((await listGrants(db)).some((g) => g.user_id === ids.alice)).toBe(false)
    await db.updateTable("environment_access").set({ role: "viewer" }).where("user_id", "=", ids.alice).execute()
  })

  it("rejects duplicate grants", async () => {
    await expect(
      db.insertInto("environment_access").values({ user_id: ids.alice, environment_id: ids.local, created_at: now }).execute()
    ).rejects.toThrow()
  })

  it("removes grants when an environment or user is deleted", async () => {
    await db.deleteFrom("environments").where("id", "=", ids.remote).execute()
    expect(await db.selectFrom("environment_access").selectAll().where("environment_id", "=", ids.remote).execute()).toEqual([])
    await db.deleteFrom("users").where("id", "=", ids.alice).execute()
    expect(await db.selectFrom("environment_access").selectAll().where("user_id", "=", ids.alice).execute()).toEqual([])
  })

  it("rejects grants for missing users or environments", async () => {
    await expect(
      db.insertInto("environment_access").values({ user_id: 999_999, environment_id: ids.local, created_at: now }).execute()
    ).rejects.toThrow()
  })
})

describe("grant form values", () => {
  it("parses <id>:<role> and defaults a bare id to operator", () => {
    expect(parseGrants(["3:viewer", "4:manager", "5"])).toEqual([
      { id: 3, role: "viewer" },
      { id: 4, role: "manager" },
      { id: 5, role: "operator" },
    ])
    expect(parseGrants([])).toEqual([])
  })

  it.each([["3:admin"], ["x:viewer"], ["3:viewer:1"], ["0:viewer"], ["-1:viewer"], ["1.5:viewer"], [" 3:viewer"]])(
    "rejects %s",
    (value) => {
      expect(parseGrants([value])).toBeNull()
    }
  )

  it("rejects non-string values (files)", () => {
    expect(parseGrants([new Blob(["x"])])).toBeNull()
  })
})
