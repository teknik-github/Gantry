import type { Metadata } from "next"

import { NetworksTable, type NetworkRow } from "@/components/gantry/networks-table"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { requireUser } from "@/lib/server/auth/dal"
import { getDocker, getPermissions } from "@/lib/server/environments"
import { tryDocker } from "@/lib/server/views"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.networks }
}

const BUILTIN = new Set(["bridge", "host", "none"])

export default async function NetworksPage() {
  await requireUser()
  const { t, format } = await getI18n()
  const can = await getPermissions()
  const result = await tryDocker(async () => {
    const api = await getDocker()
    const [networks, containers] = await Promise.all([api.listNetworks(), api.listContainers(true)])
    return { networks, containers }
  })

  if (result.error !== undefined) {
    return (
      <PageBody>
        <PageHeader title={t.nav.pages.networks} />
        <DockerUnavailable message={result.error} />
      </PageBody>
    )
  }

  // /networks omits attached containers; count them from container settings.
  const attached = new Map<string, number>()
  for (const c of result.data.containers) {
    for (const n of Object.values(c.NetworkSettings?.Networks ?? {})) attached.set(n.NetworkID, (attached.get(n.NetworkID) ?? 0) + 1)
  }

  const rows: NetworkRow[] = result.data.networks
    .map((n) => ({
      id: n.Id,
      name: n.Name,
      driver: n.Driver,
      scope: n.Scope,
      subnet: n.IPAM.Config?.map((c) => c.Subnet).filter(Boolean).join(", ") ?? "",
      gateway: n.IPAM.Config?.map((c) => c.Gateway).filter(Boolean).join(", ") ?? "",
      containers: attached.get(n.Id) ?? 0,
      builtin: BUILTIN.has(n.Name),
      internal: n.Internal,
    }))
    .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name))

  return (
    <PageBody>
      <PageHeader title={t.nav.pages.networks} description={format(t.networks.count, { count: rows.length })} />
      <NetworksTable data={rows} canManage={can.manage} />
    </PageBody>
  )
}
