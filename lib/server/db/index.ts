import "server-only"

import path from "node:path"
import { Kysely, MysqlDialect, SqliteDialect, type Dialect } from "kysely"
import { Migrator } from "kysely/migration"

import { config, ensureDataDir } from "@/lib/server/config"
import { migrationProvider } from "@/lib/server/db/migrations"
import { openSqlite } from "@/lib/server/db/sqlite"
import type { Database } from "@/lib/server/db/schema"

// Survive dev hot reloads without opening a new pool on every edit.
const globalForDb = globalThis as unknown as {
  __gantryDb?: Promise<Kysely<Database>>
}

async function createDialect(): Promise<Dialect> {
  if (config.dbDriver === "mysql") {
    const { createPool } = await import("mysql2")
    const pool = config.mysql.url
      ? createPool({ uri: config.mysql.url, connectionLimit: 10 })
      : createPool({
          host: config.mysql.host,
          port: config.mysql.port,
          user: config.mysql.user,
          password: config.mysql.password,
          database: config.mysql.database,
          connectionLimit: 10,
        })
    return new MysqlDialect({ pool })
  }

  const file = config.sqlitePath ?? path.join(ensureDataDir(), "gantry.db")
  return new SqliteDialect({ database: openSqlite(file) })
}

const RETRYABLE = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR",
])

async function migrate(db: Kysely<Database>) {
  // MySQL may still be starting when the app boots under docker compose.
  for (let attempt = 1; ; attempt++) {
    try {
      const { error, results } = await new Migrator({
        db,
        provider: migrationProvider,
        // Features land from parallel branches; each migration only adds its
        // own tables/columns, so one merged later may run after a newer one.
        allowUnorderedMigrations: true,
      }).migrateToLatest()
      for (const r of results ?? []) {
        if (r.status === "Success") console.log(`[gantry] migration ${r.migrationName} applied`)
        if (r.status === "Error") console.error(`[gantry] migration ${r.migrationName} failed`)
      }
      if (error) throw error
      return
    } catch (err) {
      const code = (err as { code?: string }).code ?? ""
      if (!RETRYABLE.has(code) || attempt >= 30) throw err
      console.warn(`[gantry] database not reachable (${code}), retry ${attempt}/30`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

async function init() {
  const db = new Kysely<Database>({ dialect: await createDialect() })
  await migrate(db)
  return db
}

export function getDb(): Promise<Kysely<Database>> {
  if (!globalForDb.__gantryDb) {
    globalForDb.__gantryDb = init().catch((err) => {
      // Allow the next request to retry instead of caching the failure.
      globalForDb.__gantryDb = undefined
      throw err
    })
  }
  return globalForDb.__gantryDb
}
