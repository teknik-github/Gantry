// Deterministic layout for the topology graph: every connected island
// (typically one compose project with its networks and volumes) is laid out
// left-to-right with dagre — networks | containers (dependents before their
// dependencies) | volumes and bind mounts — and the islands are then packed
// into rows so large hosts stay roughly screen-shaped.

import dagre from "@dagrejs/dagre"

import type { ContainerNode, PortMapping, TopologyEdge, TopologyGraph } from "@/lib/topology"

export const SIZES = {
  container: { width: 248, height: 64, portsHeight: 22 },
  network: { width: 210, height: 48 },
  volume: { width: 210, height: 48 },
  bind: { width: 210, height: 48 },
}

const LAYOUT = { nodesep: 40, ranksep: 100, edgesep: 12 }
/** Space between packed islands. */
const GAP = 64
/** Target width:height of the packed result. */
const ASPECT = 2

export type Point = { x: number; y: number }
export type Box = { x: number; y: number; width: number; height: number }

export type TopologyLayout = {
  /** Absolute top-left positions for containers, networks, volumes, binds and projects. */
  nodes: Record<string, Box>
  /** Dagre's route for each edge (absolute coordinates, source → target). */
  edges: Record<string, Point[]>
  width: number
  height: number
}

// Port badges are 10px monospace; estimate their width so heights stay deterministic.
const CHAR_W = 6.2
const BADGE_PAD = 10
const BADGE_GAP = 4

/** Which published ports fit on the single badge row of a container node. */
export function portBadges(ports: PortMapping[], maxWidth = SIZES.container.width - 24) {
  const published = ports.filter((p) => p.published)
  const shown: PortMapping[] = []
  let used = 0
  for (const [i, p] of published.entries()) {
    const w = p.label.length * CHAR_W + BADGE_PAD
    const rest = published.length - i - 1
    // Leave room for a "+N" badge if more would follow.
    const reserve = rest > 0 ? BADGE_GAP + 4 * CHAR_W + BADGE_PAD : 0
    if (used + w + reserve > maxWidth && shown.length > 0) break
    shown.push(p)
    used += w + BADGE_GAP
  }
  return { shown, hidden: published.length - shown.length }
}

export function containerSize(c: ContainerNode) {
  const hasPorts = c.ports.some((p) => p.published)
  return {
    width: SIZES.container.width,
    height: SIZES.container.height + (hasPorts ? SIZES.container.portsHeight : 0),
  }
}

/** Layout direction: networks feed containers, containers feed their dependencies and storage. */
function layoutEnds(e: TopologyEdge): [string, string] {
  return e.kind === "network" ? [e.target, e.source] : [e.source, e.target]
}

/**
 * Longest-path level of each project member along depends_on edges
 * (0 = nothing depends on it); returns the members on the first and last
 * level per project.
 */
function dependencyLevels(ids: string[], parentOf: Map<string, string>, edges: TopologyEdge[]) {
  const level = new Map<string, number>()
  for (const id of ids) if (parentOf.has(id)) level.set(id, 0)
  const deps = edges.filter((e) => e.kind === "depends" && parentOf.get(e.source) && parentOf.get(e.source) === parentOf.get(e.target))
  // Bellman-Ford style relaxation; bounded so a (bogus) cycle can't loop forever.
  for (let i = 0; i < level.size; i++) {
    let changed = false
    for (const e of deps) {
      const next = level.get(e.source)! + 1
      if (next > level.get(e.target)! && next < level.size) {
        level.set(e.target, next)
        changed = true
      }
    }
    if (!changed) break
  }
  const first = new Map<string, string[]>()
  const last = new Map<string, string[]>()
  const max = new Map<string, number>()
  for (const [id, l] of level) max.set(parentOf.get(id)!, Math.max(max.get(parentOf.get(id)!) ?? 0, l))
  for (const [id, l] of level) {
    const p = parentOf.get(id)!
    if (l === 0) first.set(p, [...(first.get(p) ?? []), id])
    if (l === max.get(p)) last.set(p, [...(last.get(p) ?? []), id])
  }
  return { first, last }
}

class UnionFind {
  private parent = new Map<string, string>()
  find(x: string): string {
    const p = this.parent.get(x) ?? x
    if (p === x) return x
    const root = this.find(p)
    this.parent.set(x, root)
    return root
  }
  union(a: string, b: string) {
    const ra = this.find(a)
    const rb = this.find(b)
    // Keep the lexicographically smaller root so results don't depend on call order.
    if (ra === rb) return
    if (ra < rb) this.parent.set(rb, ra)
    else this.parent.set(ra, rb)
  }
}

type Island = {
  key: string
  hasProject: boolean
  nodes: Record<string, Box>
  edges: Record<string, Point[]>
  width: number
  height: number
}

export function layoutTopology(graph: TopologyGraph): TopologyLayout {
  const sizes = new Map<string, { width: number; height: number }>()
  // Insertion order matters to dagre: networks, containers, volumes, binds.
  for (const n of graph.networks) sizes.set(n.id, SIZES.network)
  for (const c of graph.containers) sizes.set(c.id, containerSize(c))
  for (const v of graph.volumes) sizes.set(v.id, SIZES.volume)
  for (const b of graph.binds) sizes.set(b.id, SIZES.bind)

  const parentOf = new Map<string, string>()
  for (const p of graph.projects) for (const id of p.containerIds) if (sizes.has(id)) parentOf.set(id, p.id)

  const edges = graph.edges.filter((e) => sizes.has(e.source) && sizes.has(e.target))

  // Islands: connected components, with a project's containers always together.
  const uf = new UnionFind()
  for (const [child, parent] of parentOf) uf.union(child, parent)
  for (const e of edges) uf.union(e.source, e.target)

  const members = new Map<string, string[]>()
  for (const id of sizes.keys()) {
    const root = uf.find(id)
    members.set(root, [...(members.get(root) ?? []), id])
  }

  const projectName = new Map(graph.projects.map((p) => [p.id, p.name]))
  const label = new Map<string, string>()
  for (const c of graph.containers) label.set(c.id, c.name)
  for (const n of graph.networks) label.set(n.id, n.name)
  for (const v of graph.volumes) label.set(v.id, v.name)
  for (const b of graph.binds) label.set(b.id, b.source)

  const islands: Island[] = []
  for (const ids of members.values()) {
    const set = new Set(ids)
    const projects = [...new Set(ids.map((id) => parentOf.get(id)).filter((p): p is string => !!p))].sort()
    const g = new dagre.graphlib.Graph({ compound: projects.length > 0, multigraph: true })
    g.setGraph({ rankdir: "LR", ...LAYOUT, marginx: 0, marginy: 0 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const p of projects) g.setNode(p, {})
    for (const id of ids) {
      g.setNode(id, { ...sizes.get(id)! })
      const parent = parentOf.get(id)
      if (parent) g.setParent(id, parent)
    }
    const islandEdges = edges.filter((e) => set.has(e.source))
    for (const e of islandEdges) {
      const [from, to] = layoutEnds(e)
      // Depends edges are short and important; keep them straight.
      g.setEdge(from, to, { weight: e.kind === "depends" ? 4 : 1, minlen: 1 }, e.id)
    }
    // A project spans several ranks when its services depend on each other.
    // Without help, dagre parks outside nodes (networks, volumes) inside that
    // rank span, i.e. above or below the group, with long vertical edges.
    // Weightless helper edges from the group's first/last dependency level
    // push them beside the group instead.
    const { first, last } = dependencyLevels(ids, parentOf, islandEdges)
    for (const e of islandEdges) {
      const [from, to] = layoutEnds(e)
      const pFrom = parentOf.get(from)
      const pTo = parentOf.get(to)
      if (pFrom === pTo) continue
      for (const m of pTo ? (first.get(pTo) ?? []) : []) if (m !== to) g.setEdge(from, m, { weight: 0, minlen: 1 }, `aux:${e.id}:${m}`)
      for (const m of pFrom ? (last.get(pFrom) ?? []) : []) if (m !== from) g.setEdge(m, to, { weight: 0, minlen: 1 }, `aux:${e.id}:${m}`)
    }
    dagre.layout(g)

    const boxes: Record<string, Box> = {}
    for (const id of [...projects, ...ids]) {
      const n = g.node(id)
      boxes[id] = { x: n.x - n.width / 2, y: n.y - n.height / 2, width: n.width, height: n.height }
    }
    const routes: Record<string, Point[]> = {}
    for (const e of islandEdges) {
      const [from, to] = layoutEnds(e)
      const label = g.edge(from, to, e.id) as { points?: Point[] } | undefined
      routes[e.id] = (label?.points ?? []).map((p) => ({ x: p.x, y: p.y }))
    }

    // Normalise to the island's own origin.
    const all = Object.values(boxes)
    const minX = Math.min(...all.map((b) => b.x))
    const minY = Math.min(...all.map((b) => b.y))
    const maxX = Math.max(...all.map((b) => b.x + b.width))
    const maxY = Math.max(...all.map((b) => b.y + b.height))
    for (const b of all) {
      b.x -= minX
      b.y -= minY
    }
    for (const pts of Object.values(routes)) {
      for (const p of pts) {
        p.x -= minX
        p.y -= minY
      }
    }

    const key = projects.length
      ? projects.map((p) => projectName.get(p) ?? p).sort()[0]
      : ids.filter((id) => id.startsWith("container:")).map((id) => label.get(id) ?? id).sort()[0] ??
        ids.map((id) => label.get(id) ?? id).sort()[0]
    islands.push({ key, hasProject: projects.length > 0, nodes: boxes, edges: routes, width: maxX - minX, height: maxY - minY })
  }

  // Tallest first (rows of similar height pack tightly), then compose
  // projects before standalone containers, then by name.
  islands.sort(
    (a, b) =>
      b.height - a.height || Number(b.hasProject) - Number(a.hasProject) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  )

  // Shelf packing into rows; the canvas is usually about twice as wide as tall.
  const area = islands.reduce((sum, i) => sum + (i.width + GAP) * (i.height + GAP), 0)
  const rowWidth = Math.max(Math.sqrt(area * ASPECT), ...islands.map((i) => i.width))
  const out: TopologyLayout = { nodes: {}, edges: {}, width: 0, height: 0 }
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const island of islands) {
    if (x > 0 && x + island.width > rowWidth) {
      x = 0
      y += rowHeight + GAP
      rowHeight = 0
    }
    for (const [id, b] of Object.entries(island.nodes)) out.nodes[id] = { ...b, x: b.x + x, y: b.y + y }
    for (const [id, pts] of Object.entries(island.edges)) out.edges[id] = pts.map((p) => ({ x: p.x + x, y: p.y + y }))
    out.width = Math.max(out.width, x + island.width)
    out.height = Math.max(out.height, y + island.height)
    x += island.width + GAP
    rowHeight = Math.max(rowHeight, island.height)
  }
  return out
}
