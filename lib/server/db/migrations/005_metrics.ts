import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

// Resource usage history. Timestamps are ISO strings like elsewhere (they
// sort and compare correctly as text); byte counts are doubles because
// mysql2 returns BIGINT columns as strings.
export const metrics: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("metrics")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("environment_id", "integer", (c) => c.notNull())
      .addColumn("ts", "varchar(32)", (c) => c.notNull())
      .addColumn("containers", "integer", (c) => c.notNull())
      .addColumn("cpu", "double precision", (c) => c.notNull())
      .addColumn("mem_used", "double precision", (c) => c.notNull())
      .addColumn("mem_total", "double precision", (c) => c.notNull())
      .execute()

    await db.schema
      .createIndex("metrics_environment_ts_idx")
      .on("metrics")
      .columns(["environment_id", "ts"])
      .execute()
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable("metrics").execute()
  },
}
