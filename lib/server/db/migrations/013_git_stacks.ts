import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

// Stacks sourced from a Git repository (one row per Git stack; stacks
// without a row are edited in Gantry). Credentials and the webhook secret
// are encrypted by the app before they are stored.
export const gitStacks: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("stack_git")
      .addColumn("stack_id", "integer", (c) => c.primaryKey())
      .addColumn("repo_url", "varchar(2048)", (c) => c.notNull())
      .addColumn("ref", "varchar(255)", (c) => c.notNull())
      .addColumn("compose_path", "varchar(1024)", (c) => c.notNull())
      // Encrypted JSON {username, token}; null = public repository.
      .addColumn("credentials", "text")
      // Last successfully deployed commit, shown on the stack page.
      .addColumn("commit_sha", "varchar(64)")
      .addColumn("commit_subject", "varchar(1000)")
      .addColumn("commit_author", "varchar(255)")
      .addColumn("commit_date", "varchar(40)")
      // Fingerprint of commit + .env + compose path at the last successful deploy.
      .addColumn("deployed_hash", "varchar(64)")
      // Opaque id in the webhook URL and the encrypted secret; null = webhook off.
      .addColumn("webhook_id", "varchar(64)")
      .addColumn("webhook_secret", "text")
      .addColumn("poll_minutes", "integer", (c) => c.notNull().defaultTo(0))
      .addColumn("last_checked_at", "varchar(32)")
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addColumn("updated_at", "varchar(32)", (c) => c.notNull())
      // Table-level constraint: MySQL silently ignores inline column REFERENCES.
      .addForeignKeyConstraint("stack_git_stack_fk", ["stack_id"], "stacks", ["id"], (fk) => fk.onDelete("cascade"))
      .execute()
    await db.schema.createIndex("stack_git_webhook_idx").on("stack_git").column("webhook_id").unique().execute()
  },

  async down(db: Kysely<unknown>) {
    await db.schema.dropTable("stack_git").execute()
  },
}
