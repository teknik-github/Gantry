import type { Metadata } from "next"

import { ChartAreaInteractive } from "@/components/chart-area-interactive"
import { ContainersTable } from "@/components/gantry/containers-table"
import { DockerUnavailable, PageBody, PageHeader } from "@/components/gantry/ui"
import { SectionCards } from "@/components/section-cards"
import { formatBytes } from "@/lib/format"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getDocker } from "@/lib/server/environments"
import { containerReferences, containerUpdates } from "@/lib/server/image-updates"
import { toContainerRows, tryDocker } from "@/lib/server/views"

export const metadata: Metadata = { title: "Dashboard" }

export default async function DashboardPage() {
  const user = await requireUser()
  const env = await getCurrentEnvironment()

  const result = await tryDocker(async () => {
    const api = await getDocker()
    const [info, containers, images, volumes, networks] = await Promise.all([
      api.info(),
      api.listContainers(true),
      api.listImages(),
      api.listVolumes(),
      api.listNetworks(),
    ])
    const refs = await containerReferences(api, containers)
    return { info, containers, images, volumes, networks, refs }
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

  const { containers, images, volumes, networks, refs } = result.data
  const running = containers.filter((c) => c.State === "running").length
  const paused = containers.filter((c) => c.State === "paused").length

  return (
    <PageBody>
      {header}
      <SectionCards
        summary={{
          containers: { total: containers.length, running, paused, stopped: containers.length - running - paused },
          images: {
            total: images.length,
            size: formatBytes(images.reduce((a, i) => a + i.Size, 0)),
            dangling: images.filter((i) => !i.RepoTags?.length || i.RepoTags[0] === "<none>:<none>").length,
          },
          volumes: { total: volumes.length },
          networks: {
            total: networks.length,
            custom: networks.filter((n) => !["bridge", "host", "none"].includes(n.Name)).length,
          },
        }}
      />
      <div className="px-4 lg:px-6">
        <ChartAreaInteractive />
      </div>
      <ContainersTable
        data={toContainerRows(containers, { refs, updates: env ? containerUpdates(env.id, containers, images, refs) : undefined })}
        isAdmin={user.role === "admin"}
      />
    </PageBody>
  )
}
