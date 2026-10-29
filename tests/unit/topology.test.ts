import { describe, expect, it } from "vitest"

import type { ContainerSummary, Network, Volume } from "@/lib/server/docker/api"
import {
  buildTopology,
  DEFAULT_FILTERS,
  nodeMatches,
  parseDependsOn,
  portMappings,
  STANDALONE,
  visibleTopology,
  withNetworkAliases,
  type TopologyEdge,
  type TopologyGraph,
} from "@/lib/topology"
import { layoutTopology, portBadges } from "@/lib/topology-layout"

// Fixtures shaped like real /containers/json?all=1, /networks and /volumes
// responses (Docker 29, API 1.55), trimmed to the fields Gantry reads.

const hex = (seed: string) => seed.repeat(64).slice(0, 64)

const NET = {
  shopDefault: hex("a1"),
  shopBackend: hex("b2"),
  bridge: hex("c3"),
  host: hex("d4"),
  none: hex("e5"),
  staleBridge: hex("f6"),
}

function compose(project: string, service: string, dependsOn = "", extra: Record<string, string> = {}) {
  return {
    "com.docker.compose.project": project,
    "com.docker.compose.service": service,
    "com.docker.compose.depends_on": dependsOn,
    "com.docker.compose.oneoff": "False",
    "com.docker.compose.container-number": "1",
    "com.docker.compose.project.working_dir": `/srv/${project}`,
    "com.docker.compose.project.config_files": `/srv/${project}/compose.yaml,/srv/${project}/compose.override.yaml`,
    "com.docker.compose.version": "5.2.0",
    ...extra,
  }
}

function endpoint(networkId: string, ip: string, aliases: string[] | null = null) {
  return {
    IPAMConfig: null,
    Links: null,
    Aliases: aliases,
    NetworkID: networkId,
    EndpointID: ip ? hex("9") : "",
    Gateway: ip ? ip.replace(/\.\d+$/, ".1") : "",
    IPAddress: ip,
    MacAddress: "",
    DNSNames: null,
  }
}

function container(
  id: string,
  name: string,
  rest: Partial<ContainerSummary> & Pick<ContainerSummary, "State">
): ContainerSummary {
  return {
    Id: hex(id),
    Names: [`/${name}`],
    Image: "alpine:3",
    ImageID: `sha256:${hex("0")}`,
    Command: "sleep infinity",
    Created: 1790000000,
    Status: rest.State === "running" ? "Up 2 hours" : "Exited (0) 3 hours ago",
    Ports: [],
    Labels: {},
    Mounts: [],
    NetworkSettings: { Networks: {} },
    ...rest,
  }
}

const containers: ContainerSummary[] = [
  // Compose project "shop": web → api → db (healthy), web → cache; worker on the backend network only.
  container("1", "shop-web-1", {
    State: "running",
    Image: "nginx:1.27",
    Labels: compose("shop", "web", "api:service_started:false,cache:service_healthy:true"),
    Ports: [
      { IP: "0.0.0.0", PrivatePort: 80, PublicPort: 8080, Type: "tcp" },
      { IP: "::", PrivatePort: 80, PublicPort: 8080, Type: "tcp" },
      { IP: "127.0.0.1", PrivatePort: 443, PublicPort: 8443, Type: "tcp" },
      { PrivatePort: 9113, Type: "tcp" },
    ],
    Mounts: [
      { Type: "bind", Source: "/srv/shop/nginx.conf", Destination: "/etc/nginx/nginx.conf", Mode: "ro", RW: false },
    ],
    HostConfig: { NetworkMode: "shop_default" },
    NetworkSettings: { Networks: { shop_default: endpoint(NET.shopDefault, "172.20.0.4") } },
  }),
  container("2", "shop-api-1", {
    State: "running",
    Image: "ghcr.io/acme/shop-api:2.3.1",
    Labels: compose("shop", "api", "db:service_healthy:false"),
    Ports: [{ IP: "127.0.0.1", PrivatePort: 3000, PublicPort: 3001, Type: "tcp" }],
    Mounts: [
      { Type: "volume", Name: "shop_uploads", Source: "/var/lib/docker/volumes/shop_uploads/_data", Destination: "/app/uploads", Driver: "local", Mode: "z", RW: true },
      { Type: "bind", Source: "/srv/shop/.env", Destination: "/app/.env", Mode: "", RW: false },
    ],
    HostConfig: { NetworkMode: "shop_default" },
    NetworkSettings: {
      Networks: {
        shop_default: endpoint(NET.shopDefault, "172.20.0.3"),
        shop_backend: endpoint(NET.shopBackend, "172.21.0.3", ["shop-api-1", "api", "internal-api", hex("2").slice(0, 12)]),
      },
    },
  }),
  container("3", "shop-db-1", {
    State: "running",
    Image: "postgres:17",
    Labels: compose("shop", "db"),
    Mounts: [
      { Type: "volume", Name: "shop_pgdata", Source: "/var/lib/docker/volumes/shop_pgdata/_data", Destination: "/var/lib/postgresql/data", Driver: "local", Mode: "rw", RW: true },
      { Type: "volume", Name: "shop_uploads", Source: "/var/lib/docker/volumes/shop_uploads/_data", Destination: "/backup/uploads", Driver: "local", Mode: "ro", RW: false },
    ],
    HostConfig: { NetworkMode: "shop_backend" },
    NetworkSettings: { Networks: { shop_backend: endpoint(NET.shopBackend, "172.21.0.2", ["shop-db-1", "db", "postgres"]) } },
  }),
  // Stopped: keeps its stale IP in the list response.
  container("4", "shop-cache-1", {
    State: "exited",
    Image: "redis:7",
    Labels: compose("shop", "cache"),
    Mounts: [{ Type: "volume", Name: "shop_cache", Source: "", Destination: "/data", Driver: "local", Mode: "", RW: true }],
    HostConfig: { NetworkMode: "shop_default" },
    NetworkSettings: { Networks: { shop_default: endpoint(NET.shopDefault, "172.20.0.4") } },
  }),
  // Depends on a service that has no container, with odd label spacing and duplicates.
  container("5", "shop-worker-1", {
    State: "running",
    Labels: compose("shop", "worker", " db : service_healthy : false ,, queue:service_started,db:service_started:true,"),
    HostConfig: { NetworkMode: "shop_backend" },
    NetworkSettings: { Networks: { shop_backend: endpoint(NET.shopBackend, "172.21.0.5") } },
  }),
  // `docker compose run` one-off: part of the project, never a dependency target.
  container("6", "shop-db-run-1a2b", {
    State: "exited",
    Labels: compose("shop", "db", "", { "com.docker.compose.oneoff": "True" }),
    HostConfig: { NetworkMode: "shop_backend" },
    NetworkSettings: { Networks: { shop_backend: endpoint(NET.shopBackend, "") } },
  }),
  // Standalone on the host network.
  container("7", "node-exporter", {
    State: "running",
    Image: "prom/node-exporter",
    HostConfig: { NetworkMode: "host" },
    NetworkSettings: { Networks: { host: endpoint(NET.host, "") } },
    Mounts: [{ Type: "bind", Source: "/", Destination: "/host", Mode: "ro,rslave", RW: false }],
  }),
  // Standalone, no networks at all (network_mode: none lists "none"; this one lists nothing).
  container("8", "offline-job", {
    State: "created",
    HostConfig: { NetworkMode: "none" },
    NetworkSettings: { Networks: {} },
  }),
  // Standalone sidecar sharing another container's network stack.
  container("9", "debug-sidecar", {
    State: "running",
    HostConfig: { NetworkMode: `container:${hex("2")}` },
    NetworkSettings: { Networks: {} },
  }),
  // Standalone on the default bridge with a stale NetworkID (bridge was recreated) and an anonymous volume.
  container("a", "old-builder", {
    State: "exited",
    HostConfig: { NetworkMode: "bridge" },
    NetworkSettings: { Networks: { bridge: endpoint(NET.staleBridge, "") } },
    Mounts: [{ Type: "volume", Name: hex("7"), Source: "", Destination: "/var/lib/docker", Driver: "local", Mode: "", RW: true }],
  }),
  // Attached to a network that has since been removed; tmpfs mounts are ignored.
  container("b", "orphan", {
    State: "exited",
    HostConfig: { NetworkMode: "gone_net" },
    NetworkSettings: { Networks: { gone_net: endpoint(hex("8"), "") } },
    Mounts: [{ Type: "tmpfs", Source: "", Destination: "/tmp" }],
  }),
]

const network = (Id: string, Name: string, Driver: string, extra: Partial<Network> = {}): Network => ({
  Id,
  Name,
  Driver,
  Scope: "local",
  Created: "2026-09-30T16:42:10.577535952Z",
  Internal: false,
  IPAM: { Config: Driver === "bridge" ? [{ Subnet: "172.20.0.0/16", Gateway: "172.20.0.1" }] : null },
  Labels: {},
  ...extra,
})

const networks: Network[] = [
  network(NET.none, "none", "null"),
  network(NET.host, "host", "host"),
  network(NET.bridge, "bridge", "bridge"),
  network(NET.shopDefault, "shop_default", "bridge", { Labels: { "com.docker.compose.project": "shop" } }),
  network(NET.shopBackend, "shop_backend", "bridge", {
    Internal: true,
    IPAM: { Config: [{ Subnet: "172.21.0.0/16", Gateway: "172.21.0.1" }] },
    Labels: { "com.docker.compose.project": "shop" },
  }),
  network(hex("99"), "unused_net", "bridge"),
]

const volume = (Name: string, project?: string): Volume => ({
  Name,
  Driver: "local",
  Mountpoint: `/var/lib/docker/volumes/${Name}/_data`,
  CreatedAt: "2026-09-30T16:42:10Z",
  Labels: project ? { "com.docker.compose.project": project } : null,
  Scope: "local",
})

const volumes: Volume[] = [
  volume("shop_pgdata", "shop"),
  volume("shop_uploads", "shop"),
  volume("shop_cache", "shop"),
  volume(hex("7")),
  volume("leftover_data"),
  volume("another_leftover"),
]

const graph = buildTopology({ containers, networks, volumes })

const cid = (seed: string) => `container:${hex(seed)}`
const find = (g: TopologyGraph, id: string) => g.containers.find((c) => c.id === id)!
const edgesOf = (g: TopologyGraph, kind: TopologyEdge["kind"]) => g.edges.filter((e) => e.kind === kind)

describe("parseDependsOn", () => {
  it("parses compose's service:condition:restart list", () => {
    expect(parseDependsOn("portal-migrate:service_completed_successfully:false,redis:service_healthy:true")).toEqual([
      { service: "portal-migrate", condition: "service_completed_successfully", restart: false },
      { service: "redis", condition: "service_healthy", restart: true },
    ])
  })

  it("handles empty, partial and malformed values", () => {
    expect(parseDependsOn(undefined)).toEqual([])
    expect(parseDependsOn("")).toEqual([])
    expect(parseDependsOn(" , ,")).toEqual([])
    expect(parseDependsOn(":service_started:false")).toEqual([])
    expect(parseDependsOn("db")).toEqual([{ service: "db", condition: "service_started", restart: null }])
    expect(parseDependsOn("db::maybe")).toEqual([{ service: "db", condition: "service_started", restart: null }])
    expect(parseDependsOn("b:x:TRUE,a:y:false:extra")).toEqual([
      { service: "a", condition: "y", restart: false },
      { service: "b", condition: "x", restart: true },
    ])
  })

  it("keeps the first entry for duplicated services", () => {
    expect(parseDependsOn("db:service_healthy:false,db:service_started:true")).toEqual([
      { service: "db", condition: "service_healthy", restart: false },
    ])
  })
})

describe("portMappings", () => {
  it("lists each published mapping once and keeps a specific host IP", () => {
    expect(portMappings(containers[0].Ports)).toEqual([
      { label: "8080:80/tcp", ip: null, published: true },
      { label: "8443:443/tcp", ip: "127.0.0.1", published: true },
      { label: "9113/tcp", ip: null, published: false },
    ])
    expect(portMappings(undefined)).toEqual([])
  })
})

describe("buildTopology", () => {
  it("groups compose containers by project with service names", () => {
    expect(graph.projects).toHaveLength(1)
    const shop = graph.projects[0]
    expect(shop).toMatchObject({
      id: "project:shop",
      name: "shop",
      workingDir: "/srv/shop",
      configFiles: ["/srv/shop/compose.yaml", "/srv/shop/compose.override.yaml"],
    })
    expect(shop.containerIds.map((id) => find(graph, id).service)).toEqual(["api", "cache", "db", "db", "web", "worker"])
    expect(find(graph, cid("1"))).toMatchObject({ name: "shop-web-1", project: "shop", service: "web", image: "nginx:1.27" })
  })

  it("leaves standalone containers outside any project and sorts them after projects", () => {
    const standalone = graph.containers.filter((c) => c.project === null).map((c) => c.name)
    expect(standalone).toEqual(["debug-sidecar", "node-exporter", "offline-job", "old-builder", "orphan"])
    expect(graph.containers.slice(-5).every((c) => c.project === null)).toBe(true)
    expect(find(graph, cid("7")).service).toBeNull()
  })

  it("links containers to networks with IPs and meaningful aliases", () => {
    const api = edgesOf(graph, "network").filter((e) => e.source === cid("2"))
    expect(api).toEqual([
      expect.objectContaining({ target: `network:${NET.shopDefault}`, ip: "172.20.0.3", aliases: [] }),
      {
        kind: "network",
        id: `net:${cid("2")}->network:${NET.shopBackend}`,
        source: cid("2"),
        target: `network:${NET.shopBackend}`,
        ip: "172.21.0.3",
        // Container name and short id are dropped.
        aliases: ["api", "internal-api"],
      },
    ])
    const backend = graph.networks.find((n) => n.name === "shop_backend")!
    expect(backend).toMatchObject({ driver: "bridge", internal: true, builtin: false, project: "shop", subnets: ["172.21.0.0/16"], missing: false })
  })

  it("does not show stale IPs of stopped containers", () => {
    const cache = edgesOf(graph, "network").find((e) => e.source === cid("4"))!
    expect(cache).toMatchObject({ ip: null })
  })

  it("marks built-in networks and records them on the container", () => {
    const host = graph.networks.find((n) => n.name === "host")!
    expect(host.builtin).toBe(true)
    expect(find(graph, cid("7"))).toMatchObject({ networkMode: "host", builtinNetworks: ["host"] })
    expect(edgesOf(graph, "network").some((e) => e.source === cid("7") && e.target === host.id)).toBe(true)
  })

  it("matches stale network ids by name and keeps removed networks as missing", () => {
    const bridgeEdge = edgesOf(graph, "network").find((e) => e.source === cid("a"))!
    expect(bridgeEdge.target).toBe(`network:${NET.bridge}`)
    const gone = graph.networks.find((n) => n.name === "gone_net")!
    expect(gone).toMatchObject({ missing: true, dockerId: null, builtin: false, driver: "unknown" })
  })

  it("handles containers without networks and shared network namespaces", () => {
    expect(graph.edges.filter((e) => e.source === cid("8"))).toEqual([])
    expect(find(graph, cid("8"))).toMatchObject({ builtinNetworks: [], networkMode: "none" })
    expect(edgesOf(graph, "netns")).toEqual([
      { kind: "netns", id: `ns:${cid("9")}->${cid("2")}`, source: cid("9"), target: cid("2") },
    ])
  })

  it("links named volumes with mount path and read-only flag", () => {
    const db = edgesOf(graph, "volume").filter((e) => e.source === cid("3"))
    expect(db).toEqual([
      expect.objectContaining({ target: "volume:shop_pgdata", destination: "/var/lib/postgresql/data", readOnly: false }),
      expect.objectContaining({ target: "volume:shop_uploads", destination: "/backup/uploads", readOnly: true }),
    ])
    expect(graph.volumes.find((v) => v.name === "shop_uploads")).toMatchObject({ project: "shop", anonymous: false, missing: false })
    expect(graph.volumes.find((v) => v.name === hex("7"))).toMatchObject({ anonymous: true })
  })

  it("collects bind mounts separately, with read-only from RW or Mode", () => {
    expect(graph.binds.map((b) => b.source)).toEqual(["/", "/srv/shop/.env", "/srv/shop/nginx.conf"])
    const binds = edgesOf(graph, "bind")
    expect(binds.find((e) => e.source === cid("1"))).toMatchObject({ destination: "/etc/nginx/nginx.conf", readOnly: true })
    expect(binds.find((e) => e.source === cid("7"))).toMatchObject({ target: "bind:/", readOnly: true })
  })

  it("only includes networks and volumes that some container uses", () => {
    expect(graph.networks.map((n) => n.name)).toEqual(["bridge", "gone_net", "host", "shop_backend", "shop_default"])
    expect(graph.volumes.map((v) => v.name)).not.toContain("leftover_data")
    expect(graph.unused).toEqual({ networks: 1, volumes: 2 })
  })

  it("draws depends_on edges to every container of the target service", () => {
    const deps = edgesOf(graph, "depends").map((e) => [find(graph, e.source).name, find(graph, e.target).name, e.kind === "depends" && e.condition])
    expect(deps).toEqual(
      expect.arrayContaining([
        ["shop-web-1", "shop-api-1", "service_started"],
        ["shop-web-1", "shop-cache-1", "service_healthy"],
        ["shop-api-1", "shop-db-1", "service_healthy"],
        ["shop-worker-1", "shop-db-1", "service_healthy"],
      ])
    )
    // The one-off "db" container is never a target.
    expect(edgesOf(graph, "depends").some((e) => e.target === cid("6"))).toBe(false)
    expect(edgesOf(graph, "depends")).toHaveLength(4)
  })

  it("keeps unresolved dependencies on the container for the details panel", () => {
    expect(find(graph, cid("5")).dependsOn).toEqual([
      { service: "db", condition: "service_healthy", restart: false, targets: [cid("3")] },
      { service: "queue", condition: "service_started", restart: null, targets: [] },
    ])
  })

  it("is deterministic regardless of input order", () => {
    const shuffled = buildTopology({
      containers: [...containers].reverse(),
      networks: [...networks].reverse(),
      volumes: [...volumes].reverse(),
    })
    expect(shuffled).toEqual(graph)
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph)
  })

  it("survives sparse API objects", () => {
    const sparse = { Id: hex("c"), Names: [], Image: "x", State: "running", Status: "", Labels: null } as unknown as ContainerSummary
    const g = buildTopology({ containers: [sparse], networks: [], volumes: [] })
    expect(g.containers[0]).toMatchObject({ name: hex("c").slice(0, 12), project: null, ports: [], networkMode: null })
    expect(g.edges).toEqual([])
  })
})

describe("withNetworkAliases", () => {
  it("fills aliases from inspect data without overriding what the list returned", () => {
    const [enriched] = withNetworkAliases([containers[0]], new Map([[hex("1"), { shop_default: ["shop-web-1", "web"] }]]))
    expect(enriched.NetworkSettings.Networks.shop_default.Aliases).toEqual(["shop-web-1", "web"])
    const g = buildTopology({ containers: [enriched], networks, volumes })
    expect(edgesOf(g, "network")[0]).toMatchObject({ aliases: ["web"] })
    // Unchanged when nothing is known about the container.
    expect(withNetworkAliases([containers[1]], new Map())[0]).toBe(containers[1])
  })
})

describe("visibleTopology", () => {
  it("hides built-in networks and bind mounts by default", () => {
    const v = visibleTopology(graph, DEFAULT_FILTERS)
    expect(v.containers).toHaveLength(graph.containers.length)
    expect(v.networks.map((n) => n.name)).toEqual(["gone_net", "shop_backend", "shop_default"])
    expect(v.binds).toEqual([])
    expect(v.edges.some((e) => e.kind === "bind")).toBe(false)
    expect(v.edges.some((e) => e.target === `network:${NET.host}`)).toBe(false)
  })

  it("can show built-in networks and bind mounts", () => {
    const v = visibleTopology(graph, { ...DEFAULT_FILTERS, showBuiltinNetworks: true, showBindMounts: true })
    expect(v.networks.map((n) => n.name)).toContain("host")
    expect(v.binds).toHaveLength(3)
  })

  it("filters by compose project and keeps only what that project uses", () => {
    const v = visibleTopology(graph, { ...DEFAULT_FILTERS, project: "shop" })
    expect(v.projects.map((p) => p.name)).toEqual(["shop"])
    expect(v.containers.every((c) => c.project === "shop")).toBe(true)
    expect(v.volumes.map((vol) => vol.name)).toEqual(["shop_cache", "shop_pgdata", "shop_uploads"])
    expect(v.networks.map((n) => n.name)).toEqual(["shop_backend", "shop_default"])
    // The sidecar outside the project is gone, and so is its edge.
    expect(v.edges.some((e) => e.kind === "netns")).toBe(false)
  })

  it("filters standalone containers", () => {
    const v = visibleTopology(graph, { ...DEFAULT_FILTERS, project: STANDALONE })
    expect(v.projects).toEqual([])
    expect(v.containers.map((c) => c.name)).toEqual(["debug-sidecar", "node-exporter", "offline-job", "old-builder", "orphan"])
    expect(v.volumes.map((vol) => vol.anonymous)).toEqual([true])
  })

  it("hides stopped containers with their exclusive volumes and dependency edges", () => {
    const v = visibleTopology(graph, { ...DEFAULT_FILTERS, hideStopped: true })
    expect(v.containers.some((c) => c.state === "exited" || c.state === "created")).toBe(false)
    expect(v.volumes.map((vol) => vol.name)).toEqual(["shop_pgdata", "shop_uploads"])
    expect(v.edges.some((e) => e.target === cid("4"))).toBe(false)
    expect(v.projects[0].containerIds).not.toContain(cid("4"))
  })

  it("drops projects whose containers are all hidden", () => {
    const v = visibleTopology(graph, { ...DEFAULT_FILTERS, project: "nope" })
    expect(v).toMatchObject({ projects: [], containers: [], networks: [], volumes: [], edges: [] })
  })
})

describe("nodeMatches", () => {
  it("searches containers by name, service, image, project and port", () => {
    const web = find(graph, cid("1"))
    for (const q of ["SHOP-WEB", "web", "nginx", "shop", "8080", hex("1").slice(0, 8)]) expect(nodeMatches(web, q)).toBe(true)
    expect(nodeMatches(web, "postgres")).toBe(false)
    expect(nodeMatches(web, "   ")).toBe(false)
  })

  it("searches networks, volumes and bind mounts by name", () => {
    expect(nodeMatches(graph.networks.find((n) => n.name === "shop_backend")!, "backend")).toBe(true)
    expect(nodeMatches(graph.volumes.find((v) => v.name === "shop_pgdata")!, "pgdata")).toBe(true)
    expect(nodeMatches(graph.binds[1], ".env")).toBe(true)
  })
})

describe("layoutTopology", () => {
  const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

  const full = visibleTopology(graph, { ...DEFAULT_FILTERS, showBuiltinNetworks: true, showBindMounts: true })
  const layout = layoutTopology(full)

  it("positions every visible node and routes every edge", () => {
    for (const n of [...full.containers, ...full.networks, ...full.volumes, ...full.binds, ...full.projects]) {
      expect(layout.nodes[n.id], n.id).toBeDefined()
    }
    for (const e of full.edges) expect(layout.edges[e.id]?.length, e.id).toBeGreaterThanOrEqual(2)
    expect(layout.width).toBeGreaterThan(0)
    expect(layout.height).toBeGreaterThan(0)
  })

  it("keeps project containers inside their group box and nothing else overlapping", () => {
    const group = layout.nodes["project:shop"]
    const inside = new Set(full.projects[0].containerIds)
    for (const id of inside) {
      const b = layout.nodes[id]
      expect(b.x).toBeGreaterThanOrEqual(group.x)
      expect(b.y).toBeGreaterThanOrEqual(group.y)
      expect(b.x + b.width).toBeLessThanOrEqual(group.x + group.width)
      expect(b.y + b.height).toBeLessThanOrEqual(group.y + group.height)
    }
    const leaves = Object.entries(layout.nodes).filter(([id]) => !id.startsWith("project:"))
    for (const [i, [a, ba]] of leaves.entries()) {
      for (const [b, bb] of leaves.slice(i + 1)) expect(overlaps(ba, bb), `${a} / ${b}`).toBe(false)
      if (!inside.has(a)) expect(overlaps(ba, group), `${a} overlaps the shop group`).toBe(false)
    }
  })

  it("puts networks left of their containers and dependencies right of dependents", () => {
    const x = (id: string) => layout.nodes[id].x
    expect(x(`network:${NET.shopDefault}`)).toBeLessThan(x(cid("1")))
    expect(x(cid("1"))).toBeLessThan(x(cid("2")))
    expect(x(cid("2"))).toBeLessThan(x(cid("3")))
    expect(x(cid("3"))).toBeLessThan(x("volume:shop_pgdata"))
  })

  it("is deterministic", () => {
    expect(layoutTopology(full)).toEqual(layout)
    expect(layoutTopology(visibleTopology(buildTopology({ containers: [...containers].reverse(), networks, volumes }), { ...DEFAULT_FILTERS, showBuiltinNetworks: true, showBindMounts: true }))).toEqual(layout)
  })

  it("handles an empty graph", () => {
    expect(layoutTopology(visibleTopology(graph, { ...DEFAULT_FILTERS, project: "nope" }))).toEqual({ nodes: {}, edges: {}, width: 0, height: 0 })
  })

  it("stays readable for a large host: islands packed into a screen-shaped area", () => {
    const many: ContainerSummary[] = []
    const nets: Network[] = []
    const vols: Volume[] = []
    for (let p = 0; p < 12; p++) {
      const project = `proj${String(p).padStart(2, "0")}`
      const netId = hex(String(p % 10)).slice(0, 60) + String(p).padStart(4, "0")
      nets.push(network(netId, `${project}_default`, "bridge"))
      for (let s = 0; s < 4; s++) {
        const id = `${p}${s}`.padEnd(64, "e")
        const svc = ["web", "api", "db", "cache"][s]
        vols.push(volume(`${project}_${svc}`))
        many.push(
          container(id.slice(0, 2), `${project}-${svc}-1`, {
            Id: id,
            State: "running",
            Labels: compose(project, svc, s === 0 ? "api:service_started:false" : s === 1 ? "db:service_healthy:false" : ""),
            NetworkSettings: { Networks: { [`${project}_default`]: endpoint(netId, `172.30.${p}.${s + 2}`) } },
            Mounts: [{ Type: "volume", Name: `${project}_${svc}`, Source: "", Destination: "/data", RW: true }],
          })
        )
      }
    }
    const g = buildTopology({ containers: many, networks: nets, volumes: vols })
    const l = layoutTopology(visibleTopology(g, DEFAULT_FILTERS))
    expect(Object.keys(l.nodes)).toHaveLength(12 + 48 + 12 + 48)
    const ratio = l.width / l.height
    expect(ratio).toBeGreaterThan(0.6)
    expect(ratio).toBeLessThan(3.5)
  })
})

describe("portBadges", () => {
  it("fits what it can on one row and counts the rest", () => {
    const ports = ["8080:80/tcp", "8443:443/tcp", "15432:5432/tcp", "16379:6379/tcp", "9000:9000/tcp"].map((label) => ({ label, ip: null, published: true }))
    const { shown, hidden } = portBadges(ports)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length + hidden).toBe(5)
    expect(hidden).toBeGreaterThan(0)
    expect(portBadges([{ label: "9113/tcp", ip: null, published: false }])).toEqual({ shown: [], hidden: 0 })
  })
})
