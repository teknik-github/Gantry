import type { Metadata } from "next"

import { ContainersTable } from "@/components/gantry/containers-table"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getDocker, getPermissions } from "@/lib/server/environments"
import { lastChecked, updatesFor } from "@/lib/server/image-updates"
import { toContainerRows, tryDocker } from "@/lib/server/views"

export const metadata: Metadata = { title: "Containers" }

export default async function ContainersPage() {
  await requireUser()
  const can = await getPermissions()
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
          can={can}
          pageSize={20}
          lastUpdateCheck={env ? lastChecked(env.id) : null}
        />
      )}
    </PageBody>
  )
}
