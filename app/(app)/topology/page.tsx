import type { Metadata } from "next"

import { TopologyView } from "@/components/gantry/topology-view"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { requireUser } from "@/lib/server/auth/dal"
import type { ContainerSummary, DockerApi } from "@/lib/server/docker/api"
import { getDocker } from "@/lib/server/environments"
import { tryDocker } from "@/lib/server/views"
import { buildTopology, withNetworkAliases } from "@/lib/topology"

export const metadata: Metadata = { title: "Topology" }

/** Above this, skip per-container inspects (aliases only) to keep the page fast. */
const ALIAS_LOOKUP_LIMIT = 150
const CONCURRENCY = 8

/**
 * /containers/json leaves network aliases empty; fetch them from inspect.
 * Best effort: containers that vanish or fail are simply shown without aliases.
 */
async function networkAliases(api: DockerApi, containers: ContainerSummary[]) {
  const out = new Map<string, Record<string, string[] | null | undefined>>()
  const todo = containers.filter((c) => Object.keys(c.NetworkSettings?.Networks ?? {}).length > 0)
  if (todo.length > ALIAS_LOOKUP_LIMIT) return out
  let next = 0
  async function worker() {
    while (next < todo.length) {
      const c = todo[next++]
      try {
        const info = await api.inspectContainer(c.Id)
        out.set(c.Id, Object.fromEntries(Object.entries(info.NetworkSettings?.Networks ?? {}).map(([n, ep]) => [n, ep.Aliases])))
      } catch {
        // Removed in the meantime, or the daemon refused: no aliases for this one.
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return out
}

export default async function TopologyPage({ searchParams }: PageProps<"/topology">) {
  await requireUser()
  const { project } = await searchParams

  const result = await tryDocker(async () => {
    const api = await getDocker()
    const [containers, networks, volumes] = await Promise.all([api.listContainers(true), api.listNetworks(), api.listVolumes()])
    const aliases = await networkAliases(api, containers)
    return buildTopology({ containers: withNetworkAliases(containers, aliases), networks, volumes })
  })

  const header = (
    <PageHeader
      title="Topology"
      description="How containers, compose projects, networks and volumes are connected. Click anything for details."
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

  return (
    <PageBody>
      {header}
      <TopologyView graph={result.data} initialProject={typeof project === "string" && project ? project : null} />
    </PageBody>
  )
}
