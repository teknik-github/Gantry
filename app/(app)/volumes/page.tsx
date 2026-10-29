import type { Metadata } from "next"

import { VolumesTable, type VolumeRow } from "@/components/gantry/volumes-table"
import { DockerUnavailable, PageBody, PageHeader } from "@/components/gantry/ui"
import { timeAgo } from "@/lib/format"
import { requireUser } from "@/lib/server/auth/dal"
import { getDocker } from "@/lib/server/environments"
import { tryDocker } from "@/lib/server/views"

export const metadata: Metadata = { title: "Volumes" }

export default async function VolumesPage() {
  const user = await requireUser()
  const result = await tryDocker(async () => {
    const api = await getDocker()
    const [volumes, containers] = await Promise.all([api.listVolumes(), api.listContainers(true)])
    return { volumes, containers }
  })

  if (result.error !== undefined) {
    return (
      <PageBody>
        <PageHeader title="Volumes" />
        <DockerUnavailable message={result.error} />
      </PageBody>
    )
  }

  // Volume usage isn't in /volumes; derive it from container mounts.
  const usedBy = new Map<string, string[]>()
  for (const c of result.data.containers) {
    const name = c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12)
    for (const m of c.Mounts ?? []) {
      if (m.Type === "volume" && m.Name) usedBy.set(m.Name, [...(usedBy.get(m.Name) ?? []), name])
    }
  }

  const rows: VolumeRow[] = result.data.volumes
    .map((v) => ({
      name: v.Name,
      driver: v.Driver,
      mountpoint: v.Mountpoint,
      createdLabel: v.CreatedAt ? timeAgo(v.CreatedAt) : "—",
      usedBy: usedBy.get(v.Name) ?? [],
      stack: v.Labels?.["com.docker.compose.project"] ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <PageBody>
      <PageHeader title="Volumes" description={`${rows.length} volume(s)`} />
      <VolumesTable data={rows} isAdmin={user.role === "admin"} />
    </PageBody>
  )
}
