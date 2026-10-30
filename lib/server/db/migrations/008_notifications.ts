import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

// Notification channels, the alert history, auto-update enrolment and a
// small key/value settings table.
export const notifications: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("notification_channels")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("name", "varchar(100)", (c) => c.notNull())
      .addColumn("type", "varchar(16)", (c) => c.notNull())
      // JSON, encrypted (bot tokens and webhook URLs are secrets)
      .addColumn("config", "text", (c) => c.notNull())
      // JSON array of alert kinds this channel receives
      .addColumn("events", "varchar(500)", (c) => c.notNull())
      .addColumn("enabled", "integer", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
      .execute()

    await db.schema
      .createTable("alerts")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      // No foreign key: the history outlives removed environments.
      .addColumn("environment_id", "integer")
      .addColumn("environment_name", "varchar(100)", (c) => c.notNull())
      .addColumn("kind", "varchar(32)", (c) => c.notNull())
      .addColumn("subject", "varchar(255)", (c) => c.notNull())
      .addColumn("message", "varchar(1000)", (c) => c.notNull())
      // Delivery summary, e.g. "2 sent" or "Telegram: 401 Unauthorized"
      .addColumn("delivery", "varchar(500)", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .execute()
    await db.schema.createIndex("alerts_created_idx").on("alerts").column("created_at").execute()

    await db.schema
      .createTable("auto_update_rules")
      .addColumn("environment_id", "integer", (c) => c.notNull())
      // By name: recreating a container changes its id, not its name.
      .addColumn("container_name", "varchar(255)", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addPrimaryKeyConstraint("auto_update_rules_pk", ["environment_id", "container_name"])
      .addForeignKeyConstraint("auto_update_rules_environment_fk", ["environment_id"], "environments", ["id"], (fk) =>
        fk.onDelete("cascade")
      )
      .execute()

    await db.schema
      .createTable("settings")
      .addColumn("key", "varchar(64)", (c) => c.primaryKey())
      .addColumn("value", "text", (c) => c.notNull())
      .execute()
  },

  async down(db: Kysely<unknown>) {
    for (const t of ["settings", "auto_update_rules", "alerts", "notification_channels"]) await db.schema.dropTable(t).execute()
  },
}
