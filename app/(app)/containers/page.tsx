import type { Metadata } from "next"

import { ContainersTable } from "@/components/gantry/containers-table"
import { DockerUnavailable, PageBody, PageHeader } from "@/components/gantry/ui"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getDocker } from "@/lib/server/environments"
import { lastChecked, updatesFor } from "@/lib/server/image-updates"
import { toContainerRows, tryDocker } from "@/lib/server/views"

export const metadata: Metadata = { title: "Containers" }

export default async function ContainersPage() {
  const user = await requireUser()
  const env = await getCurrentEnvironment()
  const result = await tryDocker(async () => {
    const api = await getDocker()
    const containers = await api.listContainers(true)
    return { containers, ...(env ? await updatesFor(api, env.id, containers) : {}) }
  })

  return (
    <PageBody>
      <PageHeader title="Containers" description="All containers in this environment, running or not." />
      {result.error !== undefined ? (
        <DockerUnavailable message={result.error} />
      ) : (
        <ContainersTable
          data={toContainerRows(result.data.containers, { updates: result.data.updates, refs: result.data.refs })}
          isAdmin={user.role === "admin"}
          pageSize={20}
          lastUpdateCheck={env ? lastChecked(env.id) : null}
        />
      )}
    </PageBody>
  )
}
