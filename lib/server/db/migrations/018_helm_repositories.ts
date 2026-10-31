import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

// Helm chart repositories (https:// index repositories and oci://
// registries) for installing charts on Kubernetes environments. Optional
// basic-auth credentials are encrypted by the app (lib/server/crypto.ts).
export const helmRepositories: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("helm_repositories")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      // The name helm knows the repository by (charts are "<name>/<chart>").
      .addColumn("name", "varchar(63)", (c) => c.notNull().unique())
      .addColumn("url", "varchar(2048)", (c) => c.notNull())
      // Encrypted JSON {username, password}; null = anonymous.
      .addColumn("credentials", "text")
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
      .execute()
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable("helm_repositories").execute()
  },
}
