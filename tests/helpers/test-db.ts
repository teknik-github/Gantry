import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Kysely, SqliteDialect } from "kysely"
import { Migrator } from "kysely/migration"

import { migrationProvider } from "@/lib/server/db/migrations"
import type { Database, Role } from "@/lib/server/db/schema"
import { openSqlite } from "@/lib/server/db/sqlite"
import { openMysqlTestDb, testMysqlUrl } from "./mysql"

async function openEmpty(): Promise<{ db: Kysely<Database>; cleanup: () => Promise<void> }> {
  // With GANTRY_TEST_MYSQL_URL every test database is a fresh MySQL one.
  if (testMysqlUrl) return openMysqlTestDb()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-k-db-"))
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: openSqlite(path.join(dir, "t.db")) }) })
  return {
    db,
    async cleanup() {
      await db.destroy()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** A throwaway database (SQLite, or MySQL with GANTRY_TEST_MYSQL_URL) with every migration applied. */
export async function openTestDb() {
  const { db, cleanup } = await openEmpty()
  const { error } = await new Migrator({ db, provider: migrationProvider, allowUnorderedMigrations: true }).migrateToLatest()
  if (error) throw error
  return {
    db,
    async addUser(username: string, role: Role = "user", passwordHash = "x") {
      const r = await db
        .insertInto("users")
        .values({ username, password_hash: passwordHash, role, created_at: new Date().toISOString() })
        .executeTakeFirstOrThrow()
      return Number(r.insertId)
    },
    cleanup,
  }
}
