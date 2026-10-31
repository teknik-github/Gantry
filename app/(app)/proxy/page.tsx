import type { Metadata } from "next"

import { ProxyHostsTable, ProxySettingsCard } from "@/components/gantry/proxy-ui"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { externalSnippets } from "@/lib/proxy"
import { requirePermission } from "@/lib/server/action"
import { getCurrentEnvironment, getDocker } from "@/lib/server/environments"
import { getProxySettings, listProxyHosts, PROXY_CONTAINER, PROXY_NETWORK, proxyStatus } from "@/lib/server/proxy"
import { tryDocker } from "@/lib/server/views"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.proxy }
}

export default async function ProxyPage() {
  await requirePermission("manage")
  const { t, format, timeAgo } = await getI18n()
  const env = await getCurrentEnvironment()
  if (!env) {
    return (
      <PageBody>
        <PageHeader title={t.nav.pages.proxy} />
        <DockerUnavailable message={t.common.environment.noDockerConfigured} />
      </PageBody>
    )
  }

  const [{ settings, lastError, appliedAt }, hosts] = await Promise.all([getProxySettings(env.id), listProxyHosts(env.id)])
  const docker = await tryDocker(async () => {
    const api = await getDocker()
    const [containers, status] = await Promise.all([api.listContainers(true), proxyStatus(api)])
    return { containers, status }
  })

  const containers = (docker.data?.containers ?? [])
    .map((c) => ({
      name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
      state: c.State,
      ports: [...new Set(c.Ports.map((p) => p.PrivatePort))].sort((a, b) => a - b),
    }))
    .filter((c) => c.name !== PROXY_CONTAINER)
    .sort((a, b) => a.name.localeCompare(b.name))

  const network = settings.mode === "external" ? settings.externalNetwork : PROXY_NETWORK

  return (
    <PageBody>
      <PageHeader
        title={t.nav.pages.proxy}
        description={format(t.proxy.description, { environment: env.name })}
      />
      {docker.error !== undefined ? <DockerUnavailable message={docker.error} /> : null}
      <ProxySettingsCard
        settings={settings}
        status={docker.data?.status ?? null}
        lastError={lastError}
        appliedLabel={appliedAt ? timeAgo(appliedAt) : null}
      />
      <PageHeader
        title={t.proxy.hosts}
        description={
          settings.mode === "internal"
            ? format(t.proxy.hostsInternal, { network: PROXY_NETWORK })
            : settings.mode === "external"
              ? format(t.proxy.hostsExternal, { network: settings.externalNetwork })
              : t.proxy.hostsOff
        }
      />
      <ProxyHostsTable
        mode={settings.mode}
        containers={containers}
        data={hosts.map((h) => ({
          ...h,
          targetState: containers.find((c) => c.name === h.target)?.state ?? "missing",
          snippets: externalSnippets(h, network),
        }))}
      />
    </PageBody>
  )
}
