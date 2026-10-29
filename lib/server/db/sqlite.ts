import "server-only"

import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import type { SqliteDatabase, SqliteStatement } from "kysely"

/**
 * Adapts Node's built-in `node:sqlite` to the interface Kysely's
 * SqliteDialect expects (which mirrors better-sqlite3), so SQLite needs
 * no native module.
 */
export function openSqlite(file: string): SqliteDatabase {
  const db = new DatabaseSync(file)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")

  return {
    close: () => db.close(),
    prepare(sql: string): SqliteStatement {
      const stmt = db.prepare(sql)
      const params = (p: ReadonlyArray<unknown>) => p as SQLInputValue[]
      return {
        reader: stmt.columns().length > 0,
        all: (p) => stmt.all(...params(p)),
        run: (p) => stmt.run(...params(p)),
        iterate: (p) => stmt.iterate(...params(p)),
      }
    },
  }
}
