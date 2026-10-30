import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

// Logins for private container registries, used for pulls (Engine API and
// docker compose). Passwords/tokens are encrypted (lib/server/crypto.ts).
export const registries: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("registries")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("name", "varchar(100)", (c) => c.notNull())
      // host[:port], normalised (lib/registry.ts); one login per registry.
      .addColumn("address", "varchar(255)", (c) => c.notNull().unique())
      .addColumn("username", "varchar(255)", (c) => c.notNull())
      .addColumn("password", "text", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
      .execute()
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable("registries").execute()
  },
}
