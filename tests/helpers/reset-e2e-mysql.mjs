// Empties the MySQL database the E2E web server is about to use
// (playwright.config.ts with E2E_DB=mysql), like the SQLite run starts from
// a fresh file. Drops every table of the database named in E2E_MYSQL_URL.
import { createConnection } from "mysql2/promise"

const url = process.env.E2E_MYSQL_URL
if (!url) throw new Error("E2E_MYSQL_URL is not set")

const conn = await createConnection({ uri: url })
try {
  const [rows] = await conn.query("select table_name as name from information_schema.tables where table_schema = database()")
  await conn.query("set foreign_key_checks = 0")
  for (const { name } of rows) await conn.query(`drop table \`${name.replaceAll("`", "``")}\``)
  await conn.query("set foreign_key_checks = 1")
  console.log(`[e2e] emptied MySQL database ${new URL(url).pathname.slice(1)} (${rows.length} tables)`)
} finally {
  await conn.end()
}
