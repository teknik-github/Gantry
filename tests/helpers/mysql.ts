import crypto from "node:crypto"
import { Kysely, MysqlDialect } from "kysely"

import type { Database } from "@/lib/server/db/schema"

/**
 * GANTRY_TEST_MYSQL_URL: a throwaway MySQL server the tests may create and
 * drop databases on (e.g. mysql://root:pw@127.0.0.1:3307/gantry). Each call
 * below gets a database of its own, so test files can run in parallel.
 */
export const testMysqlUrl = process.env.GANTRY_TEST_MYSQL_URL || undefined

/** A new empty database on the test server, dropped again by `cleanup`. */
export async function openMysqlTestDb(): Promise<{ db: Kysely<Database>; url: string; cleanup: () => Promise<void> }> {
  if (!testMysqlUrl) throw new Error("GANTRY_TEST_MYSQL_URL is not set")
  const { createConnection } = await import("mysql2/promise")
  const name = `gantry_test_${crypto.randomBytes(6).toString("hex")}`
  const admin = await createConnection({ uri: testMysqlUrl })
  await admin.query(`create database \`${name}\``)
  await admin.end()

  const url = new URL(testMysqlUrl)
  url.pathname = `/${name}`
  // Kysely's MysqlDialect wants mysql2's callback pool, as lib/server/db does.
  const { createPool } = await import("mysql2")
  const db = new Kysely<Database>({
    dialect: new MysqlDialect({ pool: createPool({ uri: url.toString(), connectionLimit: 4 }) }),
  })
  return {
    db,
    url: url.toString(),
    async cleanup() {
      await db.destroy()
      const conn = await createConnection({ uri: testMysqlUrl })
      await conn.query(`drop database if exists \`${name}\``)
      await conn.end()
    },
  }
}
