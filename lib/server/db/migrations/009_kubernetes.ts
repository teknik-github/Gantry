import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

// Kubernetes environments: the API server URL goes in `url`; credentials
// (token, client certificate/key, CA) are stored as one encrypted JSON value.
// One ALTER per column: SQLite can't add several at once.
export const kubernetes: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable("environments").addColumn("kube_credentials", "text").execute()
    await db.schema.alterTable("environments").addColumn("kube_namespace", "varchar(253)").execute()
    await db.schema
      .alterTable("environments")
      .addColumn("kube_insecure", "integer", (c) => c.notNull().defaultTo(0))
      .execute()
  },
}
