import "server-only"

import { buildCaddyfile, type ProxyHost, type ProxyMode, type ProxySettings, type TlsMode } from "@/lib/proxy"
import { getDb } from "@/lib/server/db"
import type { DockerApi } from "@/lib/server/docker/api"
import { DockerError } from "@/lib/server/docker/client"
import { singleFileTar } from "@/lib/server/tar"

/**
 * Gantry's reverse proxy. Internal mode runs Caddy in a container
 * ("gantry-proxy") on the environment; its Caddyfile is generated from the
 * proxy hosts, uploaded through the Docker API and loaded with
 * `caddy reload` (which refuses an invalid config and keeps the old one), so
 * it works for remote environments too. Target containers are attached to
 * the "gantry-proxy" network and reached by name. External mode only
 * attaches targets to the existing proxy's network.
 */

export const PROXY_CONTAINER = "gantry-proxy"
export const PROXY_NETWORK = "gantry-proxy"
export const PROXY_IMAGE = "caddy:2-alpine"
const PROXY_LABEL = "gantry.proxy"
const CADDYFILE_DIR = "/etc/caddy"

export type StoredHost = ProxyHost & { id: number }

export const DEFAULT_SETTINGS: ProxySettings = { mode: "off", httpPort: 80, httpsPort: 443, email: "", externalNetwork: "" }

export async function getProxySettings(environmentId: number) {
  const db = await getDb()
  const row = await db.selectFrom("proxy_settings").selectAll().where("environment_id", "=", environmentId).executeTakeFirst()
  const settings: ProxySettings = row
    ? {
        mode: row.mode as ProxyMode,
        httpPort: row.http_port,
        httpsPort: row.https_port,
        email: row.email,
        externalNetwork: row.external_network,
      }
    : DEFAULT_SETTINGS
  return { settings, lastError: row?.last_error ?? null, appliedAt: row?.applied_at ?? null }
}

export async function saveProxySettings(environmentId: number, s: ProxySettings) {
  const db = await getDb()
  const values = {
    mode: s.mode,
    http_port: s.httpPort,
    https_port: s.httpsPort,
    email: s.email,
    external_network: s.externalNetwork,
    updated_at: new Date().toISOString(),
  }
  const res = await db.updateTable("proxy_settings").set(values).where("environment_id", "=", environmentId).executeTakeFirst()
  if (Number(res.numUpdatedRows) === 0) {
    await db.insertInto("proxy_settings").values({ environment_id: environmentId, ...values, last_error: null, applied_at: null }).execute()
  }
}

async function recordApply(environmentId: number, error: string | null) {
  const db = await getDb()
  await db
    .updateTable("proxy_settings")
    .set({ last_error: error, applied_at: new Date().toISOString() })
    .where("environment_id", "=", environmentId)
    .execute()
}

export async function listProxyHosts(environmentId: number): Promise<StoredHost[]> {
  const db = await getDb()
  const rows = await db.selectFrom("proxy_hosts").selectAll().where("environment_id", "=", environmentId).orderBy("domains").execute()
  return rows.map((r) => ({
    id: r.id,
    domains: r.domains.split(",").filter(Boolean),
    target: r.target,
    port: r.port,
    tls: r.tls as TlsMode,
    enabled: r.enabled === 1,
  }))
}

export async function saveProxyHost(environmentId: number, host: ProxyHost, id?: number) {
  const db = await getDb()
  const now = new Date().toISOString()
  const values = {
    domains: host.domains.join(","),
    target: host.target,
    port: host.port,
    tls: host.tls,
    enabled: host.enabled ? 1 : 0,
    updated_at: now,
  }
  if (id) {
    await db.updateTable("proxy_hosts").set(values).where("id", "=", id).where("environment_id", "=", environmentId).execute()
    return id
  }
  const res = await db
    .insertInto("proxy_hosts")
    .values({ ...values, environment_id: environmentId, created_at: now })
    .executeTakeFirstOrThrow()
  return Number(res.insertId)
}

export async function deleteProxyHost(environmentId: number, id: number) {
  const db = await getDb()
  await db.deleteFrom("proxy_hosts").where("id", "=", id).where("environment_id", "=", environmentId).execute()
}

type ProxyContainer = {
  Id: string
  State: { Running: boolean; Status: string }
  HostConfig: { PortBindings?: Record<string, { HostPort: string }[] | null> | null }
}

export type ProxyStatus = { state: "missing" | "running" | "stopped"; httpPort?: number; httpsPort?: number }

async function inspectProxy(api: DockerApi): Promise<ProxyContainer | null> {
  try {
    return (await api.inspectContainer(PROXY_CONTAINER)) as unknown as ProxyContainer
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) return null
    throw err
  }
}

export async function proxyStatus(api: DockerApi): Promise<ProxyStatus> {
  const c = await inspectProxy(api)
  if (!c) return { state: "missing" }
  const port = (key: string) => Number(c.HostConfig.PortBindings?.[key]?.[0]?.HostPort) || undefined
  return { state: c.State.Running ? "running" : "stopped", httpPort: port("80/tcp"), httpsPort: port("443/tcp") }
}

async function ensureNetwork(api: DockerApi, name: string, create: boolean) {
  const networks = await api.listNetworks()
  if (networks.some((n) => n.Name === name)) return
  if (!create) throw new DockerError(`Docker network "${name}" doesn't exist on this environment`, 404)
  await api.createNetwork(name, "bridge")
}

/** Attaches each target container to the proxy's network (skips missing and already attached ones). */
async function attachTargets(api: DockerApi, network: string, hosts: StoredHost[]) {
  const problems: string[] = []
  for (const target of new Set(hosts.filter((h) => h.enabled).map((h) => h.target))) {
    try {
      const info = (await api.inspectContainer(target)) as unknown as { NetworkSettings: { Networks: Record<string, unknown> } }
      if (info.NetworkSettings.Networks[network]) continue
      await api.connectNetwork(network, target)
    } catch (err) {
      problems.push(`${target}: ${(err as Error).message}`)
    }
  }
  return problems
}

/** Creates (or recreates, when the ports changed) and starts the Caddy container. */
async function ensureProxyContainer(api: DockerApi, settings: ProxySettings) {
  const current = await inspectProxy(api)
  const status = current ? await proxyStatus(api) : null
  if (current && (status?.httpPort !== settings.httpPort || status?.httpsPort !== settings.httpsPort)) {
    await api.removeContainer(current.Id, { force: true })
  } else if (current) {
    if (!current.State.Running) await api.containerAction(current.Id, "start")
    return current.Id
  }

  try {
    await api.inspectImage(PROXY_IMAGE)
  } catch {
    await api.pullImage(PROXY_IMAGE)
  }
  // Start with a placeholder config; the real one is uploaded and reloaded next.
  const { Id } = await api.createContainer(PROXY_CONTAINER, {
    Image: PROXY_IMAGE,
    Cmd: ["caddy", "run", "--config", `${CADDYFILE_DIR}/Caddyfile`, "--adapter", "caddyfile"],
    Labels: { [PROXY_LABEL]: "true" },
    ExposedPorts: { "80/tcp": {}, "443/tcp": {}, "443/udp": {} },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: {
        "80/tcp": [{ HostPort: String(settings.httpPort) }],
        "443/tcp": [{ HostPort: String(settings.httpsPort) }],
        // HTTP/3
        "443/udp": [{ HostPort: String(settings.httpsPort) }],
      },
      // Certificates and Caddy's state survive recreation.
      Binds: ["gantry-proxy-data:/data", "gantry-proxy-config:/config"],
      NetworkMode: PROXY_NETWORK,
    },
  })
  try {
    await api.putArchive(Id, CADDYFILE_DIR, singleFileTar("Caddyfile", buildCaddyfile([], settings)))
    await api.containerAction(Id, "start")
  } catch (err) {
    // A port already in use fails here; don't leave a half-made container behind.
    await api.removeContainer(Id, { force: true }).catch(() => {})
    throw err
  }
  return Id
}

/** Waits until Caddy's admin API answers inside the container (fresh start). */
async function waitForCaddy(api: DockerApi, id: string) {
  for (let i = 0; i < 20; i++) {
    const res = await api.execRun(id, ["wget", "-q", "-O", "-", "http://localhost:2019/config/"], 10_000).catch(() => null)
    if (res?.exitCode === 0) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

/**
 * Brings the environment in line with its settings and hosts. Records the
 * outcome (shown on the page) and returns warnings, or throws when the
 * proxy couldn't be updated.
 */
export async function applyProxy(api: DockerApi, environmentId: number): Promise<string[]> {
  const { settings } = await getProxySettings(environmentId)
  const hosts = await listProxyHosts(environmentId)
  try {
    let warnings: string[] = []
    if (settings.mode === "internal") {
      await ensureNetwork(api, PROXY_NETWORK, true)
      const id = await ensureProxyContainer(api, settings)
      warnings = await attachTargets(api, PROXY_NETWORK, hosts)
      await waitForCaddy(api, id)
      await api.putArchive(id, CADDYFILE_DIR, singleFileTar("Caddyfile", buildCaddyfile(hosts, settings)))
      const res = await api.execRun(id, ["caddy", "reload", "--config", `${CADDYFILE_DIR}/Caddyfile`, "--adapter", "caddyfile"])
      if (res.exitCode !== 0) {
        throw new DockerError(`Caddy rejected the configuration: ${lastLines(res.output)}`, 400)
      }
    } else {
      // Off or external: the built-in proxy must not keep serving.
      await removeProxyContainer(api)
      if (settings.mode === "external") {
        await ensureNetwork(api, settings.externalNetwork, false)
        warnings = await attachTargets(api, settings.externalNetwork, hosts)
      }
    }
    await recordApply(environmentId, warnings.length ? `Some containers couldn't be attached: ${warnings.join("; ")}` : null)
    return warnings
  } catch (err) {
    await recordApply(environmentId, (err as Error).message)
    throw err
  }
}

/** Stops and removes the built-in proxy container (certificates stay in their volumes). */
export async function removeProxyContainer(api: DockerApi) {
  const c = await inspectProxy(api)
  if (c) await api.removeContainer(c.Id, { force: true })
}

function lastLines(text: string, n = 6) {
  return text.trim().split("\n").slice(-n).join(" ").replace(/\s+/g, " ").slice(0, 600)
}
