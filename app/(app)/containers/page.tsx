import type { Metadata } from "next"

import { ContainersTable } from "@/components/gantry/containers-table"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getDocker, getPermissions } from "@/lib/server/environments"
import { lastChecked, updatesFor } from "@/lib/server/image-updates"
import { toContainerRows, tryDocker } from "@/lib/server/views"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.containers }
}

export default async function ContainersPage() {
  await requireUser()
  const { t } = await getI18n()
  const can = await getPermissions()
  const env = await getCurrentEnvironment()
  const result = await tryDocker(async () => {
    const api = await getDocker()
    const containers = await api.listContainers(true)
    return { containers, ...(env ? await updatesFor(api, env.id, containers) : {}) }
  })

  return (
    <PageBody>
      <PageHeader title={t.nav.pages.containers} description={t.containers.description} />
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
