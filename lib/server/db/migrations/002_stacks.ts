import { sql, type Kysely } from "kysely"
import type { Migration } from "kysely/migration"

import { config } from "@/lib/server/config"

// MySQL's TEXT tops out at 64 KB; compose files and deploy output can be larger.
const bigText = config.dbDriver === "mysql" ? sql`mediumtext` : sql`text`

export const stacks: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("stacks")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("environment_id", "integer", (c) => c.notNull())
      // varchar, not text: MySQL can't put a unique index on a TEXT column.
      .addColumn("name", "varchar(64)", (c) => c.notNull())
      .addColumn("compose", bigText, (c) => c.notNull())
      .addColumn("env", bigText, (c) => c.notNull())
      .addColumn("created_by", "varchar(64)", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
      .addColumn("last_action", "varchar(32)")
      .addColumn("last_status", "varchar(16)")
      .addColumn("last_output", bigText)
      .addColumn("last_run_at", "varchar(32)")
      .addColumn("last_run_by", "varchar(64)")
      .addUniqueConstraint("stacks_environment_name_unique", ["environment_id", "name"])
      // Table-level constraint: MySQL silently ignores inline column REFERENCES.
      .addForeignKeyConstraint("stacks_environment_fk", ["environment_id"], "environments", ["id"], (fk) =>
        fk.onDelete("cascade")
      )
      .execute()
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable("stacks").execute()
  },
}
