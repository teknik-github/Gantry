import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

import { bigText as bigTextFor } from "@/lib/server/db/migrations/dialect"

// Image build history (lib/server/images/builds.ts): one row per build on an
// environment. `source` and `options` are JSON for a rebuild; neither holds
// credentials. The log is capped by the app (mediumtext on MySQL).
export const imageBuilds: Migration = {
  async up(db: Kysely<unknown>) {
    const bigText = bigTextFor(db)
    await db.schema
      .createTable("image_builds")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("environment_id", "integer", (c) => c.notNull())
      // No foreign key: the history stays when a user is deleted.
      .addColumn("user_id", "integer")
      .addColumn("username", "varchar(64)", (c) => c.notNull())
      // "editor" | "git" | "upload"
      .addColumn("source_kind", "varchar(16)", (c) => c.notNull())
      .addColumn("source_summary", "varchar(1000)", (c) => c.notNull())
      .addColumn("source", bigText, (c) => c.notNull())
      .addColumn("options", bigText, (c) => c.notNull())
      // JSON array of the requested tags.
      .addColumn("tags", "text", (c) => c.notNull())
      // "running" | "success" | "error" | "cancelled"
      .addColumn("status", "varchar(16)", (c) => c.notNull())
      .addColumn("error", "text")
      .addColumn("image_id", "varchar(100)")
      .addColumn("log", bigText)
      .addColumn("started_at", "varchar(32)", (c) => c.notNull())
      .addColumn("finished_at", "varchar(32)")
      // Table-level constraint: MySQL silently ignores inline column REFERENCES.
      .addForeignKeyConstraint("image_builds_environment_fk", ["environment_id"], "environments", ["id"], (fk) =>
        fk.onDelete("cascade")
      )
      .execute()
    await db.schema.createIndex("image_builds_environment_idx").on("image_builds").columns(["environment_id", "id"]).execute()
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable("image_builds").execute()
  },
}
