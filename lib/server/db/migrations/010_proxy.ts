import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

// Reverse proxy: per-environment settings and the proxy hosts
// (domain → container:port) served by Gantry's Caddy or an external proxy.
export const proxy: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("proxy_settings")
      .addColumn("environment_id", "integer", (c) => c.primaryKey())
      .addColumn("mode", "varchar(16)", (c) => c.notNull())
      .addColumn("http_port", "integer", (c) => c.notNull())
      .addColumn("https_port", "integer", (c) => c.notNull())
      .addColumn("email", "varchar(254)", (c) => c.notNull())
      .addColumn("external_network", "varchar(128)", (c) => c.notNull())
      // Outcome of the last apply, shown on the page.
      .addColumn("last_error", "text")
      .addColumn("applied_at", "varchar(32)")
      .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
      .addForeignKeyConstraint("proxy_settings_environment_fk", ["environment_id"], "environments", ["id"], (fk) =>
        fk.onDelete("cascade")
      )
      .execute()

    await db.schema
      .createTable("proxy_hosts")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("environment_id", "integer", (c) => c.notNull())
      // Comma-separated, normalized (lib/proxy.ts)
      .addColumn("domains", "varchar(1000)", (c) => c.notNull())
      .addColumn("target", "varchar(255)", (c) => c.notNull())
      .addColumn("port", "integer", (c) => c.notNull())
      .addColumn("tls", "varchar(16)", (c) => c.notNull())
      .addColumn("enabled", "integer", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
      .addForeignKeyConstraint("proxy_hosts_environment_fk", ["environment_id"], "environments", ["id"], (fk) =>
        fk.onDelete("cascade")
      )
      .execute()
    await db.schema.createIndex("proxy_hosts_environment_idx").on("proxy_hosts").column("environment_id").execute()
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable("proxy_hosts").execute()
    await db.schema.dropTable("proxy_settings").execute()
  },
}
