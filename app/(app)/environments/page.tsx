import type { Metadata } from "next"

import { EnvironmentsTable, type EnvironmentRow } from "@/components/gantry/admin-tables"
import { PageBody, PageHeader } from "@/components/gantry/ui"
import { requireAdmin } from "@/lib/server/auth/dal"
import { getDb } from "@/lib/server/db"
import { docker } from "@/lib/server/docker/api"
import { listGrants } from "@/lib/server/environment-access"
import { hasTls } from "@/lib/server/environment-target"
import { environmentTarget, getCurrentEnvironment, listEnvironments } from "@/lib/server/environments"

export const metadata: Metadata = { title: "Environments" }

export default async function EnvironmentsPage() {
  await requireAdmin()
  const db = await getDb()
  const [envs, current, grants, users] = await Promise.all([
    listEnvironments(),
    getCurrentEnvironment(),
    listGrants(db),
    db.selectFrom("users").select(["id", "username"]).where("role", "=", "user").orderBy("username").execute(),
  ])

  const rows: EnvironmentRow[] = await Promise.all(
    envs.map(async (e) => {
      const base = {
        id: e.id,
        name: e.name,
        type: e.type,
        url: e.url,
        // Only whether TLS is configured; the PEM material never leaves the server.
        tls: hasTls(e),
        current: e.id === current?.id,
        access: grants.filter((g) => g.environment_id === e.id).map((g) => ({ id: g.user_id, username: g.username })),
      }
      try {
        const info = await docker(environmentTarget(e)).info()
        return { ...base, status: "up" as const, version: info.ServerVersion, error: null }
      } catch (err) {
        return { ...base, status: "down" as const, version: null, error: (err as Error).message }
      }
    })
  )

  return (
    <PageBody>
      <PageHeader
        title="Environments"
        description="Docker hosts managed by Gantry. Administrators can use all of them; standard users only those they were given access to."
      />
      <EnvironmentsTable data={rows} users={users.map(({ id, username }) => ({ id, username }))} />
    </PageBody>
  )
}
