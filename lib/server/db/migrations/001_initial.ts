import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

import { config } from "@/lib/server/config"

export const initial: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("users")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("username", "varchar(64)", (c) => c.notNull().unique())
      .addColumn("password_hash", "varchar(255)", (c) => c.notNull())
      .addColumn("role", "varchar(16)", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .execute()

    await db.schema
      .createTable("environments")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("name", "varchar(100)", (c) => c.notNull())
      .addColumn("type", "varchar(16)", (c) => c.notNull())
      .addColumn("url", "varchar(255)", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .execute()

    await db.schema
      .createTable("audit_logs")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("user_id", "integer")
      .addColumn("username", "varchar(64)", (c) => c.notNull())
      .addColumn("action", "varchar(64)", (c) => c.notNull())
      .addColumn("target", "varchar(255)", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .execute()

    await db.schema
      .createIndex("audit_logs_created_at_idx")
      .on("audit_logs")
      .column("created_at")
      .execute()

    await (db as Kysely<{ environments: Record<string, unknown> }>)
      .insertInto("environments")
      .values({
        name: "local",
        type: "socket",
        url: config.dockerSocket,
        created_at: new Date().toISOString(),
      })
      .execute()
  },
}
