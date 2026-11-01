import type { Metadata } from "next"

import { UsersTable } from "@/components/gantry/users-table"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { requireAdmin } from "@/lib/server/auth/dal"
import { getDb } from "@/lib/server/db"
import { listGrants } from "@/lib/server/environment-access"
import { getI18n } from "@/lib/i18n/server"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.users }
}

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
  const { t, timeAgo } = await getI18n()

  return (
    <PageBody>
      <PageHeader
        title={t.nav.pages.users}
        description={t.users.description}
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
