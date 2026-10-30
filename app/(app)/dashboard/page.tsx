import { Suspense } from "react"
import type { Metadata } from "next"

import { ChartAreaInteractive } from "@/components/chart-area-interactive"
import { ContainersTable } from "@/components/gantry/containers-table"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { ImagesCard, ImagesCardSkeleton, SectionCards } from "@/components/section-cards"
import { formatBytes } from "@/lib/format"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getDocker, getPermissions } from "@/lib/server/environments"
import { updatesFor } from "@/lib/server/image-updates"
import { toContainerRows, tryDocker } from "@/lib/server/views"

export const metadata: Metadata = { title: "Dashboard" }

export default async function DashboardPage() {
  await requireUser()
  const can = await getPermissions()
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
      title={env ? `Environment: ${env.name}` : "Dashboard"}
      description={
        result.data
          ? `Docker ${result.data.info.ServerVersion} · ${result.data.info.OperatingSystem} · ${result.data.info.NCPU} CPU · ${formatBytes(result.data.info.MemTotal)} RAM`
          : env?.url
      }
    />
  )

  if (result.error !== undefined) {
    return (
      <PageBody>
        {header}
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
  const images = await getDocker()
    .then((api) => api.listImages())
    .catch(() => null)
  return (
    <ImagesCard
      images={
        images && {
          total: images.length,
          size: formatBytes(images.reduce((a, i) => a + i.Size, 0)),
          dangling: images.filter((i) => !i.RepoTags?.length || i.RepoTags[0] === "<none>:<none>").length,
        }
      }
    />
  )
}
