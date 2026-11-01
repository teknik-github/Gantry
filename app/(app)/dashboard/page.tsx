import { Suspense } from "react"
import type { Metadata } from "next"

import { ChartAreaInteractive } from "@/components/chart-area-interactive"
import { ContainersTable } from "@/components/gantry/containers-table"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { ImagesCard, ImagesCardSkeleton, SectionCards } from "@/components/section-cards"
import { SetupChecks } from "@/components/gantry/setup-checks"
import { getI18n } from "@/lib/i18n/server"
import { requireUser } from "@/lib/server/auth/dal"
import { DockerError } from "@/lib/server/docker/client"
import { getCurrentEnvironment, getDocker, getPermissions } from "@/lib/server/environments"
import { updatesFor } from "@/lib/server/image-updates"
import { setupChecks } from "@/lib/server/setup-checks"
import { toContainerRows, tryDocker } from "@/lib/server/views"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.dashboard }
}

export default async function DashboardPage() {
  const user = await requireUser()
  const i18n = await getI18n()
  const { t } = i18n
  const can = await getPermissions()
  // What an administrator still has to set up (HTTPS, backups, 2FA, alerts).
  const checks = user.role === "admin" ? await setupChecks(user) : []
  const env = await getCurrentEnvironment()

  const result = await tryDocker(async () => {
    const api = await getDocker()
    // Images are listed separately (DashboardImages): that call can be slow.
    const [info, containers, volumes, networks] = await Promise.all([
      api.info(),
      api.listContainers(true),
      api.listVolumes(),
      api.listNetworks(),
    ])
    const { refs, updates } = env ? await updatesFor(api, env.id, containers) : {}
    return { info, containers, volumes, networks, refs, updates }
  })

  const header = (
    <PageHeader
      title={env ? i18n.format(t.dashboard.environmentTitle, { name: env.name }) : t.nav.pages.dashboard}
      description={
        result.data
          ? i18n.format(t.dashboard.serverInfo, {
              version: result.data.info.ServerVersion,
              os: result.data.info.OperatingSystem,
              cpus: result.data.info.NCPU,
              memory: i18n.formatBytes(result.data.info.MemTotal),
            })
          : env?.url
      }
    />
  )

  if (result.error !== undefined) {
    return (
      <PageBody>
        {header}
        <SetupChecks checks={checks} />
        <DockerUnavailable message={result.error} />
      </PageBody>
    )
  }

  const { containers, volumes, networks, refs, updates } = result.data
  const running = containers.filter((c) => c.State === "running").length
  const paused = containers.filter((c) => c.State === "paused").length

  return (
    <PageBody>
      {header}
      <SetupChecks checks={checks} />
      <SectionCards
        summary={{
          containers: { total: containers.length, running, paused, stopped: containers.length - running - paused },
          volumes: { total: volumes.length },
          networks: {
            total: networks.length,
            custom: networks.filter((n) => !["bridge", "host", "none"].includes(n.Name)).length,
          },
        }}
        images={
          <Suspense fallback={<ImagesCardSkeleton />}>
            <DashboardImages />
          </Suspense>
        }
      />
      <div className="px-4 lg:px-6">
        <ChartAreaInteractive />
      </div>
      <ContainersTable
        data={toContainerRows(containers, { refs, updates })}
        can={can}
      />
    </PageBody>
  )
}

/** The images card, streamed in after the rest of the dashboard. */
async function DashboardImages() {
  const i18n = await getI18n()
  const images = await getDocker()
    .then((api) => api.listImages())
    .catch((err) => {
      // Docker unreachable: the rest of the dashboard says so; this card just stays empty.
      if (!(err instanceof DockerError)) console.error("[gantry] dashboard images failed", err)
      return null
    })
  return (
    <ImagesCard
      images={
        images && {
          total: images.length,
          size: i18n.formatBytes(images.reduce((a, i) => a + i.Size, 0)),
          dangling: images.filter((i) => !i.RepoTags?.length || i.RepoTags[0] === "<none>:<none>").length,
        }
      }
    />
  )
}
