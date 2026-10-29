import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

type Db = Kysely<{
  users: { id: number; role: string }
  environments: { id: number }
  environment_access: { user_id: number; environment_id: number; created_at: string }
}>

// Which environments a standard user may use (administrators use all).
// Foreign keys are table-level constraints: MySQL ignores inline REFERENCES.
export const environmentAccess: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema
      .createTable("environment_access")
      .addColumn("user_id", "integer", (c) => c.notNull())
      .addColumn("environment_id", "integer", (c) => c.notNull())
      .addColumn("created_at", "varchar(32)", (c) => c.notNull())
      .addPrimaryKeyConstraint("environment_access_pk", ["user_id", "environment_id"])
      .addForeignKeyConstraint("environment_access_user_fk", ["user_id"], "users", ["id"], (fk) =>
        fk.onDelete("cascade")
      )
      .addForeignKeyConstraint("environment_access_environment_fk", ["environment_id"], "environments", ["id"], (fk) =>
        fk.onDelete("cascade")
      )
      .execute()

    await db.schema
      .createIndex("environment_access_environment_idx")
      .on("environment_access")
      .column("environment_id")
      .execute()

    // Keep existing installs working: until now every user could use every
    // environment, so grant exactly that. New environments and users start
    // without grants.
    const typed = db as Db
    const users = await typed.selectFrom("users").select("id").where("role", "=", "user").execute()
    const envs = await typed.selectFrom("environments").select("id").execute()
    const now = new Date().toISOString()
    const rows = users.flatMap((u) => envs.map((e) => ({ user_id: u.id, environment_id: e.id, created_at: now })))
    for (let i = 0; i < rows.length; i += 500) {
      await typed.insertInto("environment_access").values(rows.slice(i, i + 500)).execute()
    }
  },
}
