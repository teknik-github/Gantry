// Topology graph model: which containers belong to which compose project and
// what they are connected to. Pure and serializable so the server page can
// build it and the client can filter and lay it out.

import { containerName } from "@/lib/format"
import type { ContainerSummary, Network, Volume } from "@/lib/server/docker/api"

export const BUILTIN_NETWORKS = ["bridge", "host", "none"]

const PROJECT_LABEL = "com.docker.compose.project"
const SERVICE_LABEL = "com.docker.compose.service"
const DEPENDS_LABEL = "com.docker.compose.depends_on"
const WORKDIR_LABEL = "com.docker.compose.project.working_dir"
const CONFIG_LABEL = "com.docker.compose.project.config_files"
const ONEOFF_LABEL = "com.docker.compose.oneoff"

export type PortMapping = {
  /** `host:container/proto` when published, `container/proto` otherwise. */
  label: string
  /** Host address the port is bound to, when it isn't all interfaces. */
  ip: string | null
  published: boolean
}

export type Dependency = {
  service: string
  condition: string
  /** Compose's `restart` flag (third field of the label); null when absent or unrecognised. */
  restart: boolean | null
  /** Container node ids running that service; empty when none exist. */
  targets: string[]
}

export type ContainerNode = {
  kind: "container"
  id: string
  dockerId: string
  name: string
  image: string
  state: string
  status: string
  project: string | null
  service: string | null
  ports: PortMapping[]
  /** HostConfig.NetworkMode, e.g. "bridge", "host", "none", "container:<id>", "<project>_default". */
  networkMode: string | null
  /** Built-in networks (bridge/host/none) the container is attached to. */
  builtinNetworks: string[]
  dependsOn: Dependency[]
}

export type NetworkNode = {
  kind: "network"
  id: string
  dockerId: string | null
  name: string
  driver: string
  scope: string
  internal: boolean
  builtin: boolean
  subnets: string[]
  project: string | null
  /** Referenced by a container but not returned by /networks (e.g. removed). */
  missing: boolean
}

export type VolumeNode = {
  kind: "volume"
  id: string
  name: string
  driver: string
  mountpoint: string | null
  project: string | null
  /** Unnamed volume (64-hex name), e.g. from an image VOLUME instruction. */
  anonymous: boolean
  missing: boolean
}

export type BindNode = {
  kind: "bind"
  id: string
  source: string
}

export type ProjectNode = {
  kind: "project"
  id: string
  name: string
  workingDir: string | null
  configFiles: string[]
  containerIds: string[]
}

export type TopologyNode = ContainerNode | NetworkNode | VolumeNode | BindNode | ProjectNode

export type TopologyEdge =
  | { kind: "network"; id: string; source: string; target: string; ip: string | null; aliases: string[] }
  | { kind: "volume"; id: string; source: string; target: string; destination: string; readOnly: boolean }
  | { kind: "bind"; id: string; source: string; target: string; destination: string; readOnly: boolean }
  | { kind: "depends"; id: string; source: string; target: string; condition: string; restart: boolean | null }
  /** `network_mode: container:<x>` / `service:<x>`: source shares target's network stack. */
  | { kind: "netns"; id: string; source: string; target: string }

export type TopologyGraph = {
  projects: ProjectNode[]
  containers: ContainerNode[]
  networks: NetworkNode[]
  volumes: VolumeNode[]
  binds: BindNode[]
  edges: TopologyEdge[]
  /** User networks and volumes no container references (not part of the graph). */
  unused: { networks: number; volumes: number }
}

export const nodeId = {
  container: (dockerId: string) => `container:${dockerId}`,
  network: (key: string) => `network:${key}`,
  volume: (name: string) => `volume:${name}`,
  bind: (source: string) => `bind:${source}`,
  project: (name: string) => `project:${name}`,
}

const ACTIVE_STATES = new Set(["running", "paused", "restarting", "removing"])

/** Exited, created and dead containers. */
export function isStopped(state: string) {
  return !ACTIVE_STATES.has(state)
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Parses compose's `com.docker.compose.depends_on` label:
 * `service:condition:restart[,service:condition:restart…]`. Tolerates empty
 * values, missing fields, stray whitespace and duplicates.
 */
export function parseDependsOn(value: string | undefined | null): Omit<Dependency, "targets">[] {
  if (!value) return []
  const seen = new Map<string, Omit<Dependency, "targets">>()
  for (const raw of value.split(",")) {
    const [service = "", condition = "", restart = ""] = raw.split(":").map((s) => s.trim())
    if (!service || seen.has(service)) continue
    const flag = restart.toLowerCase()
    seen.set(service, {
      service,
      condition: condition || "service_started",
      restart: flag === "true" ? true : flag === "false" ? false : null,
    })
  }
  return [...seen.values()].sort((a, b) => byText(a.service, b.service))
}

/** Published ports first (by host port), each mapping once (Docker lists IPv4 and IPv6 separately). */
export function portMappings(ports: ContainerSummary["Ports"] | null | undefined): PortMapping[] {
  const out = new Map<string, PortMapping & { sort: [number, number] }>()
  for (const p of ports ?? []) {
    const published = typeof p.PublicPort === "number" && p.PublicPort > 0
    const label = published ? `${p.PublicPort}:${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`
    const ip = p.IP && p.IP !== "0.0.0.0" && p.IP !== "::" ? p.IP : null
    const key = `${label}@${ip ?? "*"}`
    if (!out.has(key)) out.set(key, { label, ip, published, sort: [published ? p.PublicPort! : 1e6 + p.PrivatePort, p.PrivatePort] })
  }
  return [...out.values()]
    .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || byText(a.label, b.label) || byText(a.ip ?? "", b.ip ?? ""))
    .map(({ label, ip, published }) => ({ label, ip, published }))
}

/** Docker's aliases minus the noise it adds itself (container name, short id). */
function cleanAliases(
  ep: { Aliases?: string[] | null; DNSNames?: string[] | null },
  name: string,
  dockerId: string
): string[] {
  const out: string[] = []
  for (const a of ep.Aliases ?? ep.DNSNames ?? []) {
    if (!a || a === name || dockerId.startsWith(a) || out.includes(a)) continue
    out.push(a)
  }
  return out
}

export type TopologyInput = {
  containers: ContainerSummary[]
  networks: Network[]
  volumes: Volume[]
}

export function buildTopology({ containers, networks, volumes }: TopologyInput): TopologyGraph {
  const sortedContainers = [...containers].sort((a, b) => {
    const pa = a.Labels?.[PROJECT_LABEL] ?? "￿"
    const pb = b.Labels?.[PROJECT_LABEL] ?? "￿"
    return (
      byText(pa, pb) ||
      byText(a.Labels?.[SERVICE_LABEL] ?? "", b.Labels?.[SERVICE_LABEL] ?? "") ||
      byText(containerName(a), containerName(b)) ||
      byText(a.Id, b.Id)
    )
  })

  const networksById = new Map(networks.map((n) => [n.Id, n]))
  const networksByName = new Map(networks.map((n) => [n.Name, n]))
  const volumesByName = new Map(volumes.map((v) => [v.Name, v]))

  const usedNetworks = new Map<string, NetworkNode>()
  const usedVolumes = new Map<string, VolumeNode>()
  const binds = new Map<string, BindNode>()
  const projects = new Map<string, ProjectNode>()
  const edges = new Map<string, TopologyEdge>()
  const nodes: ContainerNode[] = []

  // service name → container node ids, per project (for depends_on).
  const services = new Map<string, Map<string, string[]>>()
  // name / id → node id (for network_mode: container:<x>).
  const containerRefs = new Map<string, string>()

  for (const c of sortedContainers) {
    const id = nodeId.container(c.Id)
    const labels = c.Labels ?? {}
    const project = labels[PROJECT_LABEL] || null
    const service = project ? labels[SERVICE_LABEL] || null : null
    containerRefs.set(c.Id, id)
    containerRefs.set(containerName(c), id)
    if (project && service && labels[ONEOFF_LABEL] !== "True") {
      const bySvc = services.get(project) ?? new Map<string, string[]>()
      bySvc.set(service, [...(bySvc.get(service) ?? []), id])
      services.set(project, bySvc)
    }
  }

  for (const c of sortedContainers) {
    const id = nodeId.container(c.Id)
    const name = containerName(c)
    const labels = c.Labels ?? {}
    const project = labels[PROJECT_LABEL] || null
    const service = project ? labels[SERVICE_LABEL] || null : null
    const active = !isStopped(c.State)

    if (project) {
      const p = projects.get(project) ?? {
        kind: "project" as const,
        id: nodeId.project(project),
        name: project,
        workingDir: null,
        configFiles: [],
        containerIds: [],
      }
      p.containerIds.push(id)
      p.workingDir ??= labels[WORKDIR_LABEL] || null
      if (!p.configFiles.length && labels[CONFIG_LABEL]) {
        p.configFiles = labels[CONFIG_LABEL].split(",").map((f) => f.trim()).filter(Boolean)
      }
      projects.set(project, p)
    }

    // Networks
    const builtinNetworks: string[] = []
    const attached = Object.entries(c.NetworkSettings?.Networks ?? {}).sort(([a], [b]) => byText(a, b))
    for (const [netName, ep] of attached) {
      // Stopped containers keep a stale NetworkID (and IP); fall back to the name.
      const net = (ep?.NetworkID && networksById.get(ep.NetworkID)) || networksByName.get(netName)
      const key = net?.Id ?? (ep?.NetworkID || netName)
      const target = nodeId.network(key)
      if (!usedNetworks.has(target)) {
        usedNetworks.set(target, {
          kind: "network",
          id: target,
          dockerId: net?.Id ?? null,
          name: net?.Name ?? netName,
          driver: net?.Driver ?? "unknown",
          scope: net?.Scope ?? "local",
          internal: net?.Internal ?? false,
          builtin: BUILTIN_NETWORKS.includes(net?.Name ?? netName),
          subnets: (net?.IPAM?.Config ?? []).map((cfg) => cfg.Subnet).filter((s): s is string => !!s),
          project: net?.Labels?.[PROJECT_LABEL] ?? null,
          missing: !net,
        })
      }
      const node = usedNetworks.get(target)!
      if (node.builtin) builtinNetworks.push(node.name)
      edges.set(`net:${id}->${target}`, {
        kind: "network",
        id: `net:${id}->${target}`,
        source: id,
        target,
        ip: active && ep?.IPAddress ? ep.IPAddress : null,
        aliases: cleanAliases(ep ?? {}, name, c.Id),
      })
    }

    // Shared network namespace: network_mode container:<id|name> (compose: service:<name>).
    const networkMode = c.HostConfig?.NetworkMode || null
    const nsRef = networkMode?.match(/^container:(.+)$/)?.[1]
    if (nsRef) {
      const target =
        containerRefs.get(nsRef) ??
        [...containerRefs.entries()].find(([ref]) => nsRef.length >= 12 && ref.startsWith(nsRef))?.[1]
      if (target && target !== id) edges.set(`ns:${id}->${target}`, { kind: "netns", id: `ns:${id}->${target}`, source: id, target })
    }

    // Mounts
    for (const m of c.Mounts ?? []) {
      const readOnly = m.RW === false || (m.RW === undefined && /(^|,)ro(,|$)/.test(m.Mode ?? ""))
      if (m.Type === "volume" && m.Name) {
        const target = nodeId.volume(m.Name)
        if (!usedVolumes.has(target)) {
          const v = volumesByName.get(m.Name)
          usedVolumes.set(target, {
            kind: "volume",
            id: target,
            name: m.Name,
            driver: v?.Driver ?? m.Driver ?? "local",
            mountpoint: v?.Mountpoint ?? null,
            project: v?.Labels?.[PROJECT_LABEL] ?? null,
            anonymous: /^[a-f0-9]{64}$/.test(m.Name),
            missing: !v,
          })
        }
        const eid = `vol:${id}->${target}:${m.Destination}`
        edges.set(eid, { kind: "volume", id: eid, source: id, target, destination: m.Destination, readOnly })
      } else if (m.Type === "bind" && m.Source) {
        const target = nodeId.bind(m.Source)
        if (!binds.has(target)) binds.set(target, { kind: "bind", id: target, source: m.Source })
        const eid = `bind:${id}->${target}:${m.Destination}`
        edges.set(eid, { kind: "bind", id: eid, source: id, target, destination: m.Destination, readOnly })
      }
    }

    // depends_on (same project, by service name)
    const dependsOn: Dependency[] = project
      ? parseDependsOn(labels[DEPENDS_LABEL]).map((d) => {
          const targets = (services.get(project)?.get(d.service) ?? []).filter((t) => t !== id)
          for (const target of targets) {
            const eid = `dep:${id}->${target}`
            edges.set(eid, { kind: "depends", id: eid, source: id, target, condition: d.condition, restart: d.restart })
          }
          return { ...d, targets }
        })
      : []

    nodes.push({
      kind: "container",
      id,
      dockerId: c.Id,
      name,
      image: c.Image,
      state: c.State,
      status: c.Status,
      project,
      service,
      ports: portMappings(c.Ports),
      networkMode,
      builtinNetworks,
      dependsOn,
    })
  }

  const usedNetworkIds = new Set([...usedNetworks.values()].map((n) => n.dockerId))
  return {
    projects: [...projects.values()].sort((a, b) => byText(a.name, b.name)),
    containers: nodes,
    networks: [...usedNetworks.values()].sort((a, b) => byText(a.name, b.name) || byText(a.id, b.id)),
    volumes: [...usedVolumes.values()].sort((a, b) => byText(a.name, b.name)),
    binds: [...binds.values()].sort((a, b) => byText(a.source, b.source)),
    edges: [...edges.values()].sort((a, b) => byText(a.id, b.id)),
    unused: {
      networks: networks.filter((n) => !usedNetworkIds.has(n.Id) && !BUILTIN_NETWORKS.includes(n.Name)).length,
      volumes: volumes.filter((v) => !usedVolumes.has(nodeId.volume(v.Name))).length,
    },
  }
}

/** Copies network aliases from container inspect data (the list endpoint omits them). */
export function withNetworkAliases(
  containers: ContainerSummary[],
  aliases: Map<string, Record<string, string[] | null | undefined>>
): ContainerSummary[] {
  return containers.map((c) => {
    const extra = aliases.get(c.Id)
    if (!extra || !c.NetworkSettings?.Networks) return c
    const networks = Object.fromEntries(
      Object.entries(c.NetworkSettings.Networks).map(([name, ep]) => [
        name,
        ep.Aliases?.length || !extra[name] ? ep : { ...ep, Aliases: extra[name] },
      ])
    )
    return { ...c, NetworkSettings: { ...c.NetworkSettings, Networks: networks } }
  })
}

// ---------------------------------------------------------------------------
// Client-side filtering

/** Pseudo project for containers that aren't part of a compose project. */
export const STANDALONE = ":standalone"

export type TopologyFilters = {
  /** null = everything; a project name; or STANDALONE. */
  project: string | null
  hideStopped: boolean
  showBuiltinNetworks: boolean
  showBindMounts: boolean
}

export const DEFAULT_FILTERS: TopologyFilters = {
  project: null,
  hideStopped: false,
  showBuiltinNetworks: false,
  showBindMounts: false,
}

/**
 * The part of the graph to draw: containers passing the filters, plus only
 * the networks/volumes/bind mounts those containers use.
 */
export function visibleTopology(graph: TopologyGraph, filters: TopologyFilters): TopologyGraph {
  const containers = graph.containers.filter((c) => {
    if (filters.hideStopped && isStopped(c.state)) return false
    if (filters.project === STANDALONE) return c.project === null
    if (filters.project !== null) return c.project === filters.project
    return true
  })
  const visible = new Set(containers.map((c) => c.id))
  const networks = new Map(
    graph.networks.filter((n) => filters.showBuiltinNetworks || !n.builtin).map((n) => [n.id, n])
  )
  const volumes = new Map(graph.volumes.map((v) => [v.id, v]))
  const binds = new Map(filters.showBindMounts ? graph.binds.map((b) => [b.id, b]) : [])

  const edges = graph.edges.filter((e) => {
    if (!visible.has(e.source)) return false
    switch (e.kind) {
      case "network":
        return networks.has(e.target)
      case "volume":
        return volumes.has(e.target)
      case "bind":
        return binds.has(e.target)
      default:
        return visible.has(e.target)
    }
  })
  const targets = new Set(edges.map((e) => e.target))

  return {
    projects: graph.projects
      .map((p) => ({ ...p, containerIds: p.containerIds.filter((id) => visible.has(id)) }))
      .filter((p) => p.containerIds.length > 0),
    containers,
    networks: [...networks.values()].filter((n) => targets.has(n.id)),
    volumes: [...volumes.values()].filter((v) => targets.has(v.id)),
    binds: [...binds.values()].filter((b) => targets.has(b.id)),
    edges,
    unused: graph.unused,
  }
}

/** Case-insensitive search over the names a user would type. */
export function nodeMatches(node: TopologyNode, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return false
  const fields =
    node.kind === "container"
      ? [node.name, node.service, node.image, node.project, node.dockerId.slice(0, 12), ...node.ports.map((p) => p.label)]
      : node.kind === "bind"
        ? [node.source]
        : [node.name]
  return fields.some((f) => f?.toLowerCase().includes(q))
}

export function allNodes(graph: TopologyGraph): TopologyNode[] {
  return [...graph.projects, ...graph.containers, ...graph.networks, ...graph.volumes, ...graph.binds]
}

/**
 * Edges of the given kinds that leave ("from": the node is the source) or
 * reach ("to": the node is the target) the node `id`, in graph order.
 */
export function edgesAt<K extends TopologyEdge["kind"]>(
  graph: Pick<TopologyGraph, "edges">,
  id: string,
  direction: "from" | "to",
  ...kinds: K[]
): Extract<TopologyEdge, { kind: K }>[] {
  const end = direction === "from" ? "source" : "target"
  return graph.edges.filter(
    (e): e is Extract<TopologyEdge, { kind: K }> => (kinds as string[]).includes(e.kind) && e[end] === id
  )
}
