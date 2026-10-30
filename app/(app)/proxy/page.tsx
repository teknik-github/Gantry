import type { Metadata } from "next"

import { ProxyHostsTable, ProxySettingsCard } from "@/components/gantry/proxy-ui"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { timeAgo } from "@/lib/format"
import { externalSnippets } from "@/lib/proxy"
import { requirePermission } from "@/lib/server/action"
import { getCurrentEnvironment, getDocker } from "@/lib/server/environments"
import { getProxySettings, listProxyHosts, PROXY_CONTAINER, PROXY_NETWORK, proxyStatus } from "@/lib/server/proxy"
import { tryDocker } from "@/lib/server/views"

export const metadata: Metadata = { title: "Proxy" }

export default async function ProxyPage() {
  await requirePermission("manage")
  const env = await getCurrentEnvironment()
  if (!env) {
    return (
      <PageBody>
        <PageHeader title="Proxy" />
        <DockerUnavailable message="No Docker environment configured" />
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
        title="Proxy"
        description={`Serve containers on ${env.name} under domain names, with HTTPS. Use Gantry's built-in Caddy proxy or attach containers to the proxy you already run.`}
      />
      {docker.error !== undefined ? <DockerUnavailable message={docker.error} /> : null}
      <ProxySettingsCard
        settings={settings}
        status={docker.data?.status ?? null}
        lastError={lastError}
        appliedLabel={appliedAt ? timeAgo(appliedAt) : null}
      />
      <PageHeader
        title="Proxy hosts"
        description={
          settings.mode === "internal"
            ? `Each host forwards its domains to a container port. Targets are attached to the "${PROXY_NETWORK}" network.`
            : settings.mode === "external"
              ? `Targets are attached to "${settings.externalNetwork}"; copy each host's config into your proxy.`
              : "Turn the proxy on above to serve these."
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
