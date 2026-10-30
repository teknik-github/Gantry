import { sql, type Kysely } from "kysely"
import type { Migration } from "kysely/migration"

import { config } from "@/lib/server/config"

// MySQL's TEXT tops out at 64 KB; compose files can be larger.
const bigText = config.dbDriver === "mysql" ? sql`mediumtext` : sql`text`

// Custom stack templates (built-in ones live in lib/template-catalog.ts).
export const templates: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("templates")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("title", "varchar(100)", (c) => c.notNull().unique())
      .addColumn("description", "varchar(500)", (c) => c.notNull())
      .addColumn("category", "varchar(64)", (c) => c.notNull())
      .addColumn("stack_name", "varchar(64)", (c) => c.notNull())
      .addColumn("compose", bigText, (c) => c.notNull())
      // dotenv with default values for the compose file's ${VARIABLES}
      .addColumn("env", bigText, (c) => c.notNull())
      .addColumn("created_by", "varchar(64)", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
      .execute()
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable("templates").execute()
  },
}
