import { sql, type Kysely, type RawBuilder } from "kysely"
import type { Migration } from "kysely/migration"

import { isMysql } from "@/lib/server/db/migrations/dialect"

// MySQL-only column fixes; SQLite doesn't enforce lengths and compares text
// byte for byte, so there is nothing to change there.
//
// Sizes: MySQL (strict mode) refuses values longer than the column, where
// SQLite stores them anyway.
// - environments.tls_* / kube_credentials hold encrypted (base64, ~4/3 the
//   size) PEM material the form accepts up to 64 KB per field, and kubeconfig
//   credentials; TEXT stops at 64 KB.
// - settings.value holds the last auto-update run (one entry per container).
// - proxy_settings.last_error lists every container that couldn't be attached.
// - proxy_hosts.domains takes up to 20 domains of up to 253 characters.
//
// Collation: MySQL's default utf8mb4_0900_ai_ci ignores case and accents.
// These values are case-sensitive identifiers, so they get utf8mb4_bin (what
// SQLite does everywhere):
// - users.oidc_issuer / oidc_subject: an OIDC subject is case-sensitive; two
//   subjects that only differ in case must not map to the same user.
// - auto_update_rules.container_name: Docker names "Web" and "web" are two
//   containers; enrolling one must not touch (or collide with) the other.
// - stack_git.webhook_id: random base64url, looked up as-is.
//
// MODIFY restates the whole column, so nullability is repeated as it was.
// Keys and indexes on the columns are kept.

type Change = { table: string; column: string; type: RawBuilder<unknown>; notNull: boolean }

const binary = (length: number) => sql.raw(`varchar(${length}) character set utf8mb4 collate utf8mb4_bin`)

const changes: Change[] = [
  { table: "environments", column: "tls_ca", type: sql`mediumtext`, notNull: false },
  { table: "environments", column: "tls_cert", type: sql`mediumtext`, notNull: false },
  { table: "environments", column: "tls_key", type: sql`mediumtext`, notNull: false },
  { table: "environments", column: "kube_credentials", type: sql`mediumtext`, notNull: false },
  { table: "settings", column: "value", type: sql`mediumtext`, notNull: true },
  { table: "proxy_settings", column: "last_error", type: sql`mediumtext`, notNull: false },
  { table: "proxy_hosts", column: "domains", type: sql`text`, notNull: true },
  { table: "users", column: "oidc_issuer", type: binary(255), notNull: false },
  { table: "users", column: "oidc_subject", type: binary(255), notNull: false },
  { table: "auto_update_rules", column: "container_name", type: binary(255), notNull: true },
  { table: "stack_git", column: "webhook_id", type: binary(64), notNull: false },
]

export const mysqlColumns: Migration = {
  async up(db: Kysely<unknown>) {
    if (!isMysql(db)) return
    for (const c of changes) {
      await db.schema
        .alterTable(c.table)
        .modifyColumn(c.column, c.type, (col) => (c.notNull ? col.notNull() : col))
        .execute()
    }
  },
}
