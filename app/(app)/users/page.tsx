import type { Metadata } from "next"

import { UsersTable } from "@/components/gantry/admin-tables"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { timeAgo } from "@/lib/format"
import { requireAdmin } from "@/lib/server/auth/dal"
import { getDb } from "@/lib/server/db"
import { listGrants } from "@/lib/server/environment-access"

export const metadata: Metadata = { title: "Users" }

export default async function UsersPage() {
  const me = await requireAdmin()
  const db = await getDb()
  const [users, environments, grants] = await Promise.all([
    db
      .selectFrom("users")
      .select(["id", "username", "role", "created_at", "totp_enabled", "oidc_subject"])
      .orderBy("username")
      .execute(),
    db.selectFrom("environments").select(["id", "name"]).orderBy("id").execute(),
    listGrants(db),
  ])

  return (
    <PageBody>
      <PageHeader
        title="Users"
        description="Administrators manage Gantry and have full control of every environment. Standard users only use the environments they were given, as viewer (read-only), operator (start, stop, restart, logs) or manager (full control of that environment)."
      />
      <UsersTable
        // Plain objects: node:sqlite rows have a null prototype.
        environments={environments.map(({ id, name }) => ({ id, name }))}
        data={users.map((u) => ({
          id: u.id,
          username: u.username,
          role: u.role,
          createdLabel: timeAgo(u.created_at),
          self: u.id === me.id,
          grants: grants.filter((g) => g.user_id === u.id).map((g) => ({ id: g.environment_id, role: g.role })),
          twoFactor: Number(u.totp_enabled) === 1,
          sso: Boolean(u.oidc_subject),
        }))}
      />
    </PageBody>
  )
}
