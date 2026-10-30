import { sql, type Kysely } from "kysely"
import { Migrator, type Migration, type MigrationProvider } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { migrationProvider } from "@/lib/server/db/migrations"
import type { Database } from "@/lib/server/db/schema"
import { encryptSecret } from "@/lib/server/crypto"
import { resolveOidcUser } from "@/lib/server/auth/oidc"
import { encryptKubeCredentials } from "@/lib/server/kubernetes/target"
import { openMysqlTestDb, testMysqlUrl } from "../helpers/mysql"

// MySQL-specific checks of the schema and of the queries whose behaviour
// differs from SQLite. Runs with GANTRY_TEST_MYSQL_URL (see tests/helpers/mysql.ts);
// the other DB tests also switch to MySQL then (tests/helpers/test-db.ts).

const current = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/lib/server/db", () => ({ getDb: async () => current.db }))

const { getSetting, setSetting } = await import("@/lib/server/settings")
const { saveProxySettings, getProxySettings, saveProxyHost, listProxyHosts } = await import("@/lib/server/proxy")
const { setEnrolled, enrolledNames } = await import("@/lib/server/auto-update")
const { findByWebhookId, setWebhook } = await import("@/lib/server/stacks/git-records")

async function allMigrations() {
  return migrationProvider.getMigrations()
}

/** The migrations up to and including `last`. */
function providerUpTo(last: string): MigrationProvider {
  return {
    async getMigrations() {
      const all = await allMigrations()
      return Object.fromEntries(Object.entries(all).filter(([name]) => name <= last)) as Record<string, Migration>
    },
  }
}

async function migrate(db: Kysely<Database>, provider: MigrationProvider = migrationProvider) {
  const res = await new Migrator({ db, provider, allowUnorderedMigrations: true }).migrateToLatest()
  if (res.error) throw res.error
  expect(res.results?.every((r) => r.status === "Success")).toBe(true)
  return res.results ?? []
}

type Column = { table_name: string; column_name: string; column_type: string; collation_name: string | null; is_nullable: string }

async function columns(db: Kysely<Database>) {
  const { rows } = await sql<Column>`
    select table_name as table_name, column_name as column_name, column_type as column_type,
           collation_name as collation_name, is_nullable as is_nullable
    from information_schema.columns where table_schema = database()`.execute(db)
  return new Map(rows.map((r) => [`${r.table_name}.${r.column_name}`, r]))
}

const now = () => new Date().toISOString()
const env = (name: string) => ({ name, type: "tcp" as const, url: `${name}:2375`, created_at: now() })

describe.skipIf(!testMysqlUrl)("MySQL", { timeout: 600_000 }, () => {
  describe("a new database", () => {
    let t: Awaited<ReturnType<typeof openMysqlTestDb>>
    beforeAll(async () => {
      t = await openMysqlTestDb()
      current.db = t.db
      await migrate(t.db)
    }, 600_000)
    afterAll(() => t?.cleanup())

    it("gets every migration", async () => {
      const applied = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(t.db)
      expect(applied.rows.map((r) => r.name)).toEqual(Object.keys(await allMigrations()).sort())
    })

    it("uses InnoDB, large text types and binary collation for case-sensitive identifiers", async () => {
      const { rows: engines } = await sql<{ engine: string }>`
        select distinct engine as engine from information_schema.tables where table_schema = database()`.execute(t.db)
      expect(engines.map((r) => r.engine)).toEqual(["InnoDB"])

      const cols = await columns(t.db)
      for (const c of [
        "stacks.compose",
        "stacks.env",
        "stacks.last_output",
        "templates.compose",
        "templates.env",
        "environments.tls_ca",
        "environments.tls_cert",
        "environments.tls_key",
        "environments.kube_credentials",
        "settings.value",
        "proxy_settings.last_error",
      ]) {
        expect(cols.get(c)?.column_type, c).toBe("mediumtext")
      }
      expect(cols.get("proxy_hosts.domains")?.column_type).toBe("text")
      for (const c of ["users.oidc_issuer", "users.oidc_subject", "auto_update_rules.container_name", "stack_git.webhook_id"]) {
        expect(cols.get(c)?.collation_name, c).toBe("utf8mb4_bin")
      }
      // Nullability is unchanged by 014's MODIFY COLUMN.
      expect(cols.get("settings.value")?.is_nullable).toBe("NO")
      expect(cols.get("proxy_hosts.domains")?.is_nullable).toBe("NO")
      expect(cols.get("auto_update_rules.container_name")?.is_nullable).toBe("NO")
      expect(cols.get("environments.tls_key")?.is_nullable).toBe("YES")
      expect(cols.get("users.oidc_subject")?.is_nullable).toBe("YES")
    })

    it("has every foreign key, with ON DELETE CASCADE", async () => {
      const { rows } = await sql<{ name: string; rule: string }>`
        select constraint_name as name, delete_rule as rule from information_schema.referential_constraints
        where constraint_schema = database() order by constraint_name`.execute(t.db)
      expect(rows).toEqual(
        [
          "api_tokens_user_fk",
          "auto_update_rules_environment_fk",
          "environment_access_environment_fk",
          "environment_access_user_fk",
          "proxy_hosts_environment_fk",
          "proxy_settings_environment_fk",
          "recovery_codes_user_fk",
          "stack_git_stack_fk",
          "stacks_environment_fk",
        ].map((name) => ({ name, rule: "CASCADE" }))
      )
    })

    it("keeps the unique keys and indexes", async () => {
      const { rows } = await sql<{ name: string; cols: string; non_unique: number }>`
        select concat(table_name, '.', index_name) as name, non_unique as non_unique,
               group_concat(column_name order by seq_in_index) as cols
        from information_schema.statistics where table_schema = database()
        group by table_name, index_name, non_unique`.execute(t.db)
      const unique = new Map(rows.filter((r) => Number(r.non_unique) === 0).map((r) => [r.name, r.cols]))
      expect(unique.get("users.users_oidc_identity_idx")).toBe("oidc_issuer,oidc_subject")
      expect(unique.get("stack_git.stack_git_webhook_idx")).toBe("webhook_id")
      expect(unique.get("auto_update_rules.PRIMARY")).toBe("environment_id,container_name")
      expect(unique.get("stacks.stacks_environment_name_unique")).toBe("environment_id,name")
      expect(unique.get("settings.PRIMARY")).toBe("key")
    })

    it("returns ids and counts as numbers", async () => {
      const res = await t.db.insertInto("environments").values(env("numbers")).executeTakeFirstOrThrow()
      expect(Number(res.insertId)).toBeGreaterThan(1)
      const count = await t.db
        .selectFrom("environments")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .executeTakeFirstOrThrow()
      expect(Number(count.n)).toBeGreaterThanOrEqual(2)
      const row = await t.db.selectFrom("environments").selectAll().where("id", "=", Number(res.insertId)).executeTakeFirstOrThrow()
      expect(typeof row.id).toBe("number")
      expect(row.kube_insecure).toBe(0)
    })

    it("stores values up to the sizes the forms accept", async () => {
      // 64 KB per PEM field (environments/actions.ts PEM_MAX), encrypted.
      const pem = "A".repeat(64 * 1024)
      const tls = encryptSecret(pem, "x")
      expect(tls.length).toBeGreaterThan(65_535)
      const kube = encryptKubeCredentials({ token: "t".repeat(64 * 1024), ca: pem })
      const id = Number(
        (
          await t.db
            .insertInto("environments")
            .values({ ...env("big"), tls_ca: tls, tls_cert: tls, tls_key: tls, kube_credentials: kube })
            .executeTakeFirstOrThrow()
        ).insertId
      )
      const back = await t.db.selectFrom("environments").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
      expect(back.tls_key).toBe(tls)
      expect(back.kube_credentials).toBe(kube)

      // 512 KB compose file (lib/stacks.ts MAX_COMPOSE_BYTES) and a long deploy log.
      const compose = `services:\n${"  # padding\n".repeat(47_000)}`
      const stackId = Number(
        (
          await t.db
            .insertInto("stacks")
            .values({ environment_id: id, name: "big", compose, env: "", created_by: "admin", created_at: now(), updated_at: now() })
            .executeTakeFirstOrThrow()
        ).insertId
      )
      await t.db.updateTable("stacks").set({ last_output: "x".repeat(1024 * 1024) }).where("id", "=", stackId).execute()
      const stack = await t.db.selectFrom("stacks").selectAll().where("id", "=", stackId).executeTakeFirstOrThrow()
      expect(stack.compose).toBe(compose)
      expect(stack.last_output).toHaveLength(1024 * 1024)

      // Git stack fields at their validation limits (lib/git-stacks.ts).
      await t.db
        .insertInto("stack_git")
        .values({
          stack_id: stackId,
          repo_url: `https://git.example.com/${"r".repeat(2000)}`,
          ref: "r".repeat(255),
          compose_path: "p".repeat(1024),
          created_at: now(),
          updated_at: now(),
        })
        .execute()
    })

    it("saves a proxy host with 20 maximum-length domains", async () => {
      const envId = Number((await t.db.insertInto("environments").values(env("proxy")).executeTakeFirstOrThrow()).insertId)
      const label = "a".repeat(63)
      const domains = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(2, "0")}${label.slice(2)}.${label}.${label}.${"b".repeat(57)}.com`)
      expect(domains.every((d) => d.length === 253)).toBe(true)
      await saveProxyHost(envId, { domains, target: "web", port: 80, tls: "off", enabled: true })
      expect((await listProxyHosts(envId))[0].domains).toEqual(domains)
    })

    it("saves settings again with an unchanged value (update-or-insert)", async () => {
      // MySQL reports 0 *changed* rows for an update that changes nothing;
      // Kysely's numUpdatedRows must count matched rows or the fallback
      // insert hits the primary key.
      await setSetting("mysql.test", "same")
      await setSetting("mysql.test", "same")
      expect(await getSetting("mysql.test")).toBe("same")
      const big = "r".repeat(200_000)
      await setSetting("mysql.test", big)
      expect(await getSetting("mysql.test")).toBe(big)

      const envId = Number((await t.db.insertInto("environments").values(env("settings")).executeTakeFirstOrThrow()).insertId)
      const settings = { mode: "internal" as const, httpPort: 80, httpsPort: 443, email: "", externalNetwork: "" }
      await saveProxySettings(envId, settings)
      await saveProxySettings(envId, settings)
      expect((await getProxySettings(envId)).settings).toEqual(settings)
    })

    it("treats container names as case-sensitive for auto-update", async () => {
      const envId = Number((await t.db.insertInto("environments").values(env("auto")).executeTakeFirstOrThrow()).insertId)
      await setEnrolled(envId, "web", true)
      await setEnrolled(envId, "Web", true)
      expect([...(await enrolledNames(envId))].sort()).toEqual(["Web", "web"])
      await setEnrolled(envId, "web", false)
      expect([...(await enrolledNames(envId))]).toEqual(["Web"])
    })

    it("never matches an OIDC subject that only differs in case", async () => {
      const issuer = "https://id.example.com"
      const a = await resolveOidcUser(t.db, { issuer, subject: "AbC", username: "sso-a", admin: null }, true)
      const b = await resolveOidcUser(t.db, { issuer, subject: "abc", username: "sso-b", admin: null }, true)
      expect(a.ok && b.ok && a.user.id !== b.user.id).toBe(true)
      const again = await resolveOidcUser(t.db, { issuer, subject: "abc", username: "x", admin: null }, false)
      expect(again.ok && b.ok && again.user.id === b.user.id).toBe(true)
    })

    it("looks webhook ids up exactly", async () => {
      const envId = Number((await t.db.insertInto("environments").values(env("hooks")).executeTakeFirstOrThrow()).insertId)
      const stackId = Number(
        (
          await t.db
            .insertInto("stacks")
            .values({ environment_id: envId, name: "hook", compose: "services: {}\n", env: "", created_by: "a", created_at: now(), updated_at: now() })
            .executeTakeFirstOrThrow()
        ).insertId
      )
      await t.db
        .insertInto("stack_git")
        .values({ stack_id: stackId, repo_url: "https://example.com/r.git", ref: "main", compose_path: "compose.yaml", created_at: now(), updated_at: now() })
        .execute()
      let { id } = await setWebhook(stackId, { keepId: false })
      // Make sure the id has letters to flip.
      while (id.toUpperCase() === id.toLowerCase()) ({ id } = await setWebhook(stackId, { keepId: false }))
      expect((await findByWebhookId(id))?.stack_id).toBe(stackId)
      const flipped = [...id].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join("")
      expect(await findByWebhookId(flipped)).toBeUndefined()
    })

    it("matches usernames case-insensitively (MySQL's default collation; documented)", async () => {
      await t.db.insertInto("users").values({ username: "carol", password_hash: "x", role: "user", created_at: now() }).execute()
      await expect(
        t.db.insertInto("users").values({ username: "Carol", password_hash: "x", role: "user", created_at: now() }).execute()
      ).rejects.toThrow(/Duplicate entry/)
      const row = await t.db.selectFrom("users").select("username").where("username", "=", "CAROL").executeTakeFirst()
      expect(row?.username).toBe("carol")
    })

    it("cascades deletes of environments and users", async () => {
      const envId = Number((await t.db.insertInto("environments").values(env("cascade")).executeTakeFirstOrThrow()).insertId)
      const userId = Number(
        (await t.db.insertInto("users").values({ username: "dave", password_hash: "x", role: "user", created_at: now() }).executeTakeFirstOrThrow())
          .insertId
      )
      const stackId = Number(
        (
          await t.db
            .insertInto("stacks")
            .values({ environment_id: envId, name: "s", compose: "services: {}\n", env: "", created_by: "a", created_at: now(), updated_at: now() })
            .executeTakeFirstOrThrow()
        ).insertId
      )
      await t.db
        .insertInto("stack_git")
        .values({ stack_id: stackId, repo_url: "https://example.com/r.git", ref: "main", compose_path: "c.yaml", created_at: now(), updated_at: now() })
        .execute()
      await t.db.insertInto("environment_access").values({ user_id: userId, environment_id: envId, role: "viewer", created_at: now() }).execute()
      await t.db.insertInto("auto_update_rules").values({ environment_id: envId, container_name: "c", created_at: now() }).execute()
      await t.db
        .insertInto("proxy_settings")
        .values({ environment_id: envId, mode: "off", http_port: 80, https_port: 443, email: "", external_network: "", updated_at: now() })
        .execute()
      await t.db
        .insertInto("proxy_hosts")
        .values({ environment_id: envId, domains: "a.example.com", target: "c", port: 80, tls: "off", enabled: 1, created_at: now(), updated_at: now() })
        .execute()
      await t.db.insertInto("api_tokens").values({ user_id: userId, name: "t", token_hash: "f".repeat(64), prefix: "gt_", created_at: now() }).execute()
      await t.db.insertInto("recovery_codes").values({ user_id: userId, code_hash: "e".repeat(64), created_at: now() }).execute()

      await t.db.deleteFrom("environments").where("id", "=", envId).execute()
      for (const table of ["stacks", "auto_update_rules", "proxy_settings", "proxy_hosts"] as const) {
        const left = await t.db.selectFrom(table).select("environment_id").where("environment_id", "=", envId).execute()
        expect(left, table).toEqual([])
      }
      expect(await t.db.selectFrom("stack_git").select("stack_id").where("stack_id", "=", stackId).execute()).toEqual([])
      expect(await t.db.selectFrom("environment_access").select("user_id").where("user_id", "=", userId).execute()).toEqual([])

      await t.db.deleteFrom("users").where("id", "=", userId).execute()
      expect(await t.db.selectFrom("api_tokens").select("id").where("user_id", "=", userId).execute()).toEqual([])
      expect(await t.db.selectFrom("recovery_codes").select("id").where("user_id", "=", userId).execute()).toEqual([])
    })

    it("orders ISO timestamps correctly", async () => {
      const envId = Number((await t.db.insertInto("environments").values(env("time")).executeTakeFirstOrThrow()).insertId)
      const times = ["2026-10-30T09:00:00.000Z", "2026-10-30T10:00:00.000Z", "2026-10-29T23:59:59.999Z"]
      for (const ts of times) {
        await t.db.insertInto("metrics").values({ environment_id: envId, ts, containers: 1, cpu: 1, mem_used: 6_442_450_944, mem_total: 1 }).execute()
      }
      const rows = await t.db
        .selectFrom("metrics")
        .select(["ts", "mem_used"])
        .where("environment_id", "=", envId)
        .where("ts", ">=", "2026-10-30T00:00:00.000Z")
        .orderBy("ts")
        .execute()
      expect(rows.map((r) => r.ts)).toEqual([times[0], times[1]])
      expect(rows[0].mem_used).toBe(6_442_450_944)
    })
  })

  describe("upgrades", () => {
    it("from 005 (the last release tested on MySQL) to the latest schema, keeping data", async () => {
      const t = await openMysqlTestDb()
      try {
        const legacy = t.db as unknown as Kysely<Record<string, Record<string, unknown>>>
        // Users from before 004, which grants them every environment.
        await migrate(t.db, providerUpTo("003_environment_tls"))
        await legacy.insertInto("users").values({ username: "admin", password_hash: "x", role: "admin", created_at: now() }).execute()
        await legacy.insertInto("users").values({ username: "alice", password_hash: "x", role: "user", created_at: now() }).execute()
        await migrate(t.db, providerUpTo("005_metrics"))
        const compose = `services:\n${"  # x\n".repeat(30_000)}`
        await legacy
          .insertInto("stacks")
          .values({ environment_id: 1, name: "app", compose, env: "A=1\n", created_by: "admin", created_at: now(), updated_at: now() })
          .execute()

        const results = await migrate(t.db)
        expect(results.map((r) => r.migrationName)).toEqual(Object.keys(await allMigrations()).filter((n) => n > "005_metrics"))

        const stack = await t.db.selectFrom("stacks").selectAll().executeTakeFirstOrThrow()
        expect(stack.compose).toBe(compose)
        const alice = await t.db.selectFrom("users").selectAll().where("username", "=", "alice").executeTakeFirstOrThrow()
        expect(alice).toMatchObject({ totp_enabled: 0, session_version: 0, oidc_subject: null })
        // 004 granted alice the local environment; 011 made that an operator grant.
        const grant = await t.db.selectFrom("environment_access").selectAll().where("user_id", "=", alice.id).executeTakeFirstOrThrow()
        expect(grant.role).toBe("operator")
        const cols = await columns(t.db)
        expect(cols.get("environments.tls_key")?.column_type).toBe("mediumtext")
        expect(cols.get("users.oidc_subject")?.collation_name).toBe("utf8mb4_bin")
      } finally {
        await t.cleanup()
      }
    })

    it("from 013 with data in every column 014 changes", async () => {
      const t = await openMysqlTestDb()
      try {
        await migrate(t.db, providerUpTo("013_git_stacks"))
        const pem = encryptSecret("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n", "x")
        await t.db.updateTable("environments").set({ tls_ca: pem, tls_cert: pem, tls_key: pem, kube_credentials: pem }).execute()
        await t.db.insertInto("settings").values({ key: "auto_update.last_run", value: '{"results":[]}' }).execute()
        await t.db
          .insertInto("proxy_settings")
          .values({ environment_id: 1, mode: "internal", http_port: 80, https_port: 443, email: "", external_network: "", last_error: "boom", updated_at: now() })
          .execute()
        await t.db
          .insertInto("proxy_hosts")
          .values({ environment_id: 1, domains: "a.example.com,b.example.com", target: "web", port: 80, tls: "auto", enabled: 1, created_at: now(), updated_at: now() })
          .execute()
        await t.db.insertInto("auto_update_rules").values({ environment_id: 1, container_name: "web", created_at: now() }).execute()
        await t.db
          .insertInto("users")
          .values({ username: "sso", password_hash: "!", role: "user", created_at: now(), oidc_issuer: "https://id", oidc_subject: "Sub-1" })
          .execute()
        const stackId = Number(
          (
            await t.db
              .insertInto("stacks")
              .values({ environment_id: 1, name: "g", compose: "services: {}\n", env: "", created_by: "a", created_at: now(), updated_at: now() })
              .executeTakeFirstOrThrow()
          ).insertId
        )
        await t.db
          .insertInto("stack_git")
          .values({ stack_id: stackId, repo_url: "https://example.com/r.git", ref: "main", compose_path: "c.yaml", webhook_id: "AbCd", created_at: now(), updated_at: now() })
          .execute()

        const results = await migrate(t.db)
        expect(results.map((r) => r.migrationName)).toEqual(["014_mysql_columns"])

        const e = await t.db.selectFrom("environments").selectAll().where("id", "=", 1).executeTakeFirstOrThrow()
        expect(e).toMatchObject({ tls_ca: pem, tls_cert: pem, tls_key: pem, kube_credentials: pem })
        expect((await t.db.selectFrom("settings").selectAll().executeTakeFirstOrThrow()).value).toBe('{"results":[]}')
        expect((await t.db.selectFrom("proxy_settings").selectAll().executeTakeFirstOrThrow()).last_error).toBe("boom")
        expect((await t.db.selectFrom("proxy_hosts").selectAll().executeTakeFirstOrThrow()).domains).toBe("a.example.com,b.example.com")
        expect((await t.db.selectFrom("auto_update_rules").selectAll().executeTakeFirstOrThrow()).container_name).toBe("web")
        expect(await t.db.selectFrom("users").select("id").where("oidc_subject", "=", "Sub-1").executeTakeFirst()).toBeDefined()
        expect(await t.db.selectFrom("users").select("id").where("oidc_subject", "=", "sub-1").executeTakeFirst()).toBeUndefined()
        expect(await t.db.selectFrom("stack_git").select("stack_id").where("webhook_id", "=", "AbCd").executeTakeFirst()).toBeDefined()
      } finally {
        await t.cleanup()
      }
    })
  })
})
