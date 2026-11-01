import type { Metadata } from "next"

import { VolumesTable, type VolumeRow } from "@/components/gantry/volumes-table"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { containerName } from "@/lib/format"
import { getI18n } from "@/lib/i18n/server"
import { requireUser } from "@/lib/server/auth/dal"
import { getDocker, getPermissions } from "@/lib/server/environments"
import { tryDocker } from "@/lib/server/views"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.volumes }
}

export default async function VolumesPage() {
  await requireUser()
  const { t, format, timeAgo } = await getI18n()
  const can = await getPermissions()
  const result = await tryDocker(async () => {
    const api = await getDocker()
    const [volumes, containers] = await Promise.all([api.listVolumes(), api.listContainers(true)])
    return { volumes, containers }
  })

  if (result.error !== undefined) {
    return (
      <PageBody>
        <PageHeader title={t.nav.pages.volumes} />
        <DockerUnavailable message={result.error} />
      </PageBody>
    )
  }

  // Volume usage isn't in /volumes; derive it from container mounts.
  const usedBy = new Map<string, string[]>()
  for (const c of result.data.containers) {
    // The file browser's short-lived helpers (lib/server/files/helper.ts) don't count.
    if (c.Labels?.["gantry.helper"]) continue
    const name = containerName(c)
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
      <PageHeader title={t.nav.pages.volumes} description={format(t.volumes.count, { count: rows.length })} />
      <VolumesTable data={rows} canManage={can.manage} canBrowse={can.operate} />
    </PageBody>
  )
}
