import type { Kysely } from "kysely"
import type { Migration } from "kysely/migration"

// Agent environments (type "agent"): a Docker host whose agent dials out to
// Gantry. Only the SHA-256 hash of the enrollment key is stored; the rest is
// what the agent last reported, shown on the Environments page. One ALTER
// per column: SQLite can't add several at once.
export const environmentAgents: Migration = {
  async up(db: Kysely<unknown>) {
    await db.schema.alterTable("environments").addColumn("agent_key_hash", "varchar(64)").execute()
    // When the current key was issued (ISO).
    await db.schema.alterTable("environments").addColumn("agent_key_created_at", "varchar(32)").execute()
    // Last time the agent was connected (ISO).
    await db.schema.alterTable("environments").addColumn("agent_seen_at", "varchar(32)").execute()
    // JSON AgentInfo (lib/server/agent/info.ts): versions, hostname, remote address.
    await db.schema.alterTable("environments").addColumn("agent_info", "text").execute()
  },
}
