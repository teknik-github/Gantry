import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

type Db = Kysely<{ environment_access: { role: string } }>

// Authentication hardening:
// - TOTP two-factor: encrypted secret, enabled flag, last accepted time step
//   (replay protection) and hashed one-time recovery codes;
// - OIDC single sign-on: users linked by issuer + subject;
// - personal API tokens, stored as SHA-256 hashes;
// - a session version per user: sessions carry it and stop working when it
//   is bumped (log out everywhere, password or role changes, 2FA reset);
// - per-environment roles for standard users. Existing grants become
//   "operator", which is what every grant allowed until now.
export const auth: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable("users").addColumn("totp_secret", "text").execute()
    await db.schema
      .alterTable("users")
      .addColumn("totp_enabled", "integer", (c) => c.notNull().defaultTo(0))
      .execute()
    await db.schema.alterTable("users").addColumn("totp_last_step", "integer").execute()
    await db.schema
      .alterTable("users")
      .addColumn("session_version", "integer", (c) => c.notNull().defaultTo(0))
      .execute()
    await db.schema.alterTable("users").addColumn("oidc_issuer", "varchar(255)").execute()
    await db.schema.alterTable("users").addColumn("oidc_subject", "varchar(255)").execute()
    // NULLs never collide, so local users are unaffected.
    await db.schema.createIndex("users_oidc_identity_idx").unique().on("users").columns(["oidc_issuer", "oidc_subject"]).execute()

    await db.schema
      .createTable("recovery_codes")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("user_id", "integer", (c) => c.notNull())
      // SHA-256 hex of the normalized code
      .addColumn("code_hash", "varchar(64)", (c) => c.notNull())
      .addColumn("used_at", "varchar(32)")
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addForeignKeyConstraint("recovery_codes_user_fk", ["user_id"], "users", ["id"], (fk) => fk.onDelete("cascade"))
      .execute()
    await db.schema.createIndex("recovery_codes_user_idx").on("recovery_codes").column("user_id").execute()

    await db.schema
      .createTable("api_tokens")
      .addColumn("id", "integer", (c) => c.primaryKey().autoIncrement())
      .addColumn("user_id", "integer", (c) => c.notNull())
      .addColumn("name", "varchar(64)", (c) => c.notNull())
      // SHA-256 hex of the whole token; the token itself is never stored
      .addColumn("token_hash", "varchar(64)", (c) => c.notNull().unique())
      // First characters, to tell tokens apart in the list
      .addColumn("prefix", "varchar(16)", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addColumn("expires_at", "varchar(32)")
      .addColumn("last_used_at", "varchar(32)")
      .addForeignKeyConstraint("api_tokens_user_fk", ["user_id"], "users", ["id"], (fk) => fk.onDelete("cascade"))
      .execute()
    await db.schema.createIndex("api_tokens_user_idx").on("api_tokens").column("user_id").execute()

    await db.schema
      .alterTable("environment_access")
      .addColumn("role", "varchar(16)", (c) => c.notNull().defaultTo("operator"))
      .execute()
    await (db as Db).updateTable("environment_access").set({ role: "operator" }).execute()
  },

  async down(db: Kysely<unknown>) {
    await db.schema.alterTable("environment_access").dropColumn("role").execute()
    await db.schema.dropTable("api_tokens").execute()
    await db.schema.dropTable("recovery_codes").execute()
    await db.schema.dropIndex("users_oidc_identity_idx").on("users").execute()
    for (const column of ["oidc_subject", "oidc_issuer", "session_version", "totp_last_step", "totp_enabled", "totp_secret"]) {
      await db.schema.alterTable("users").dropColumn(column).execute()
    }
  },
}
