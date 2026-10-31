import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

import { bigText } from "@/lib/server/db/migrations/dialect"

// Vulnerability scans (Trivy): the latest scan of each image per
// environment. A failed attempt keeps the results of the last successful
// scan and records its error next to them.
export const imageScans: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("image_scans")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("environment_id", "integer", (c) => c.notNull())
      // "sha256:<64 hex>" as the environment's daemon reports it.
      .addColumn("image_id", "varchar(80)", (c) => c.notNull())
      // What was scanned, for display: a tag ("nginx:1.27") or the short id.
      .addColumn("reference", "varchar(512)", (c) => c.notNull())
      .addColumn("repo_digest", "varchar(512)")
      // Last successful scan (null: none yet) and last attempt.
      .addColumn("scanned_at", "varchar(32)")
      .addColumn("attempted_at", "varchar(32)", (c) => c.notNull())
      .addColumn("duration_ms", "integer")
      .addColumn("trivy_version", "varchar(32)")
      // UpdatedAt of the vulnerability database the scan used.
      .addColumn("db_version", "varchar(64)")
      .addColumn("os", "varchar(100)")
      .addColumn("critical", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("high", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("medium", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("low", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("unknown", "integer", (c) => c.notNull().defaultTo(0))
      // JSON array of findings (lib/image-scan.ts), capped in size.
      .addColumn("findings", bigText(db), (c) => c.notNull())
      .addColumn("truncated", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("error", "varchar(1000)")
      // Table-level constraint: MySQL silently ignores inline column REFERENCES.
      .addForeignKeyConstraint("image_scans_environment_fk", ["environment_id"], "environments", ["id"], (fk) =>
        fk.onDelete("cascade")
      )
      .execute()
    await db.schema
      .createIndex("image_scans_image_idx")
      .on("image_scans")
      .columns(["environment_id", "image_id"])
      .unique()
      .execute()
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable("image_scans").execute()
  },
}
