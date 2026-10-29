import type { Metadata } from "next"

import { ContainersTable } from "@/components/gantry/containers-table"
import { DockerUnavailable, PageBody, PageHeader } from "@/components/gantry/ui"
import { requireUser } from "@/lib/server/auth/dal"
import { getDocker } from "@/lib/server/environments"
import { toContainerRows, tryDocker } from "@/lib/server/views"

export const metadata: Metadata = { title: "Containers" }

export default async function ContainersPage() {
  const user = await requireUser()
  const result = await tryDocker(async () => (await getDocker()).listContainers(true))

  return (
    <PageBody>
      <PageHeader title="Containers" description="All containers in this environment, running or not." />
      {result.error !== undefined ? (
        <DockerUnavailable message={result.error} />
      ) : (
        <ContainersTable data={toContainerRows(result.data)} isAdmin={user.role === "admin"} pageSize={20} />
      )}
    </PageBody>
  )
}
