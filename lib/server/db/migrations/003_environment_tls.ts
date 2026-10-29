import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

// PEM material for TLS-protected TCP environments, encrypted by the app
// before it is stored. One ALTER per column: SQLite can't add several at once.
export const environmentTls: Migration = {
  async up(db: Kysely<unknown>) {
    for (const column of ["tls_ca", "tls_cert", "tls_key"]) {
      await db.schema.alterTable("environments").addColumn(column, "text").execute()
    }
  },
}
