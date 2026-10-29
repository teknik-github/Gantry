import type { Metadata } from "next"

import { EnvironmentsTable, type EnvironmentRow } from "@/components/gantry/admin-tables"
import { PageBody, PageHeader } from "@/components/gantry/ui"
import { requireAdmin } from "@/lib/server/auth/dal"
import { docker } from "@/lib/server/docker/api"
import { getCurrentEnvironment, listEnvironments } from "@/lib/server/environments"

export const metadata: Metadata = { title: "Environments" }

export default async function EnvironmentsPage() {
  await requireAdmin()
  const [envs, current] = await Promise.all([listEnvironments(), getCurrentEnvironment()])

  const rows: EnvironmentRow[] = await Promise.all(
    envs.map(async (e) => {
      const base = { id: e.id, name: e.name, type: e.type, url: e.url, current: e.id === current?.id }
      try {
        const info = await docker({ type: e.type, url: e.url }).info()
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
        description="Docker hosts managed by Gantry. Switch between them from the sidebar."
      />
      <EnvironmentsTable data={rows} />
    </PageBody>
  )
}
