import { MysqlAdapter, sql, type Kysely } from "kysely"

/**
 * Whether a migration runs on MySQL, decided by the connection it got (not
 * DB_DRIVER), so a migration always matches the database it changes.
 */
export function isMysql(db: Kysely<unknown>) {
  return db.getExecutor().adapter instanceof MysqlAdapter
}

/** MySQL's TEXT tops out at 64 KB; compose files and deploy output can be larger. */
export function bigText(db: Kysely<unknown>) {
  return isMysql(db) ? sql`mediumtext` : sql`text`
}
