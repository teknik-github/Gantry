"use client"

import "@xyflow/react/dist/style.css"

import * as React from "react"
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
} from "@xyflow/react"
import { SearchIcon } from "lucide-react"
import { useTheme } from "next-themes"

import { TopologyDetails } from "@/components/gantry/topology-details"
import {
  edgeTypes,
  networkColor,
  nodeTypes,
  STATE_COLOR,
  type RoutedFlowEdge,
  type TopologyFlowNode,
} from "@/components/gantry/topology-nodes"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  allNodes,
  DEFAULT_FILTERS,
  nodeMatches,
  STANDALONE,
  visibleTopology,
  type TopologyEdge,
  type TopologyFilters,
  type TopologyGraph,
  type TopologyNode,
} from "@/lib/topology"
import { layoutTopology, type TopologyLayout } from "@/lib/topology-layout"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"

const ALL = ":all"

const subscribe = () => () => {}
/** True after hydration: React Flow measures the DOM and the theme is only known on the client. */
function useMounted() {
  return React.useSyncExternalStore(
    subscribe,
    () => true,
    () => false
  )
}

function edgeLabel(e: TopologyEdge, t: I18n["t"]) {
  switch (e.kind) {
    case "network":
      return [e.ip, ...e.aliases].filter(Boolean).join(" · ") || null
    case "volume":
    case "bind":
      return `${e.destination}${e.readOnly ? t.topology.readOnlyShort : ""}`
    case "depends":
      return (t.topology.edgeConditions as Record<string, string>)[e.condition] ?? e.condition
    case "netns":
      return t.topology.networkStack
  }
}

const EDGE_COLOR: Record<Exclude<TopologyEdge["kind"], "network">, string> = {
  volume: "var(--muted-foreground)",
  bind: "var(--muted-foreground)",
  depends: "#8b5cf6",
  netns: "#ec4899",
}

/** Service name, numbered when a service runs more than one container. */
function containerTitles(graph: TopologyGraph) {
  const counts = new Map<string, number>()
  for (const c of graph.containers) if (c.service) counts.set(`${c.project}/${c.service}`, (counts.get(`${c.project}/${c.service}`) ?? 0) + 1)
  const seen = new Map<string, number>()
  const titles = new Map<string, string>()
  for (const c of graph.containers) {
    if (!c.service) {
      titles.set(c.id, c.name)
      continue
    }
    const key = `${c.project}/${c.service}`
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    titles.set(c.id, (counts.get(key) ?? 0) > 1 ? `${c.service} #${n}` : c.service)
  }
  return titles
}

function toFlow(
  graph: TopologyGraph,
  layout: TopologyLayout,
  titles: Map<string, string>,
  matches: Set<string>,
  searching: boolean,
  selected: string | null,
  t: I18n["t"]
) {
  const parentOf = new Map<string, string>()
  for (const p of graph.projects) for (const id of p.containerIds) parentOf.set(id, p.id)

  // Selecting a project focuses all of its containers' connections.
  const focusIds = new Set<string>()
  if (selected) {
    focusIds.add(selected)
    for (const p of graph.projects) if (p.id === selected) p.containerIds.forEach((id) => focusIds.add(id))
  }

  const highlight = (id: string, childMatch = false) => ({
    match: searching && matches.has(id),
    dim: searching && !matches.has(id) && !childMatch,
    focus: selected === id,
  })

  const box = (id: string) => {
    const b = layout.nodes[id]
    const parent = parentOf.get(id)
    const p = parent ? layout.nodes[parent] : undefined
    return {
      position: p ? { x: b.x - p.x, y: b.y - p.y } : { x: b.x, y: b.y },
      width: b.width,
      height: b.height,
      ...(parent ? { parentId: parent, extent: "parent" as const } : {}),
    }
  }

  const nodes: TopologyFlowNode[] = []
  for (const p of graph.projects) {
    if (!layout.nodes[p.id]) continue
    const members = graph.containers.filter((c) => c.project === p.name)
    nodes.push({
      id: p.id,
      type: "project",
      ...box(p.id),
      data: {
        node: p,
        running: members.filter((c) => c.state === "running").length,
        total: members.length,
        ...highlight(p.id, p.containerIds.some((id) => matches.has(id))),
      },
      zIndex: -1,
    })
  }
  for (const c of graph.containers) {
    if (!layout.nodes[c.id]) continue
    nodes.push({ id: c.id, type: "container", ...box(c.id), data: { node: c, title: titles.get(c.id) ?? c.name, ...highlight(c.id) } })
  }
  for (const n of graph.networks) if (layout.nodes[n.id]) nodes.push({ id: n.id, type: "network", ...box(n.id), data: { node: n, ...highlight(n.id) } })
  for (const v of graph.volumes) if (layout.nodes[v.id]) nodes.push({ id: v.id, type: "volume", ...box(v.id), data: { node: v, ...highlight(v.id) } })
  for (const b of graph.binds) if (layout.nodes[b.id]) nodes.push({ id: b.id, type: "bind", ...box(b.id), data: { node: b, ...highlight(b.id) } })

  const networkName = new Map(graph.networks.map((n) => [n.id, n.name]))
  const edges: RoutedFlowEdge[] = graph.edges.map((e) => {
    // Network edges are drawn network → container, matching the layout direction.
    const [source, target] = e.kind === "network" ? [e.target, e.source] : [e.source, e.target]
    const color = e.kind === "network" ? networkColor(networkName.get(e.target) ?? e.target) : EDGE_COLOR[e.kind]
    const touchesFocus = focusIds.has(e.source) || focusIds.has(e.target)
    const emphasis = selected
      ? touchesFocus
        ? "focus"
        : "dim"
      : searching && !matches.has(e.source) && !matches.has(e.target)
        ? "dim"
        : "normal"
    const arrow = e.kind === "depends" || e.kind === "netns"
    return {
      id: e.id,
      type: "routed",
      source,
      target,
      animated: e.kind === "depends",
      markerEnd: arrow ? { type: MarkerType.ArrowClosed, color, width: 14, height: 14 } : undefined,
      data: { edge: e, route: layout.edges[e.id] ?? [], label: edgeLabel(e, t), color, emphasis },
    }
  })
  // Paint focused edges last so they sit on top of the others.
  const rank = { dim: 0, normal: 1, focus: 2 }
  edges.sort((a, b) => rank[a.data!.emphasis] - rank[b.data!.emphasis])
  return { nodes, edges }
}

function minimapColor(node: Node) {
  const n = (node as TopologyFlowNode).data.node
  switch (n.kind) {
    case "container":
      return STATE_COLOR[n.state] ?? "#9ca3af"
    case "network":
      return networkColor(n.name)
    case "project":
      return "rgba(148, 163, 184, 0.18)"
    default:
      return "#9ca3af"
  }
}

function Legend() {
  const { t } = useI18n()
  const text = t.topology.legend
  const item = (label: string, stroke: string, dash?: string) => (
    <span className="flex items-center gap-1.5">
      <svg width="22" height="6" aria-hidden>
        <line x1="0" y1="3" x2="22" y2="3" stroke={stroke} strokeWidth="2" strokeDasharray={dash} />
      </svg>
      {label}
    </span>
  )
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 rounded-md border bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-xs">
      {item(text.network, networkColor("network"))}
      {item(text.volume, "var(--muted-foreground)")}
      {item(text.bind, "var(--muted-foreground)", "2 3")}
      {item(text.depends, EDGE_COLOR.depends, "5 3")}
    </div>
  )
}

function Canvas({
  graph,
  layout,
  titles,
  query,
  selected,
  onSelect,
}: {
  graph: TopologyGraph
  layout: TopologyLayout
  titles: Map<string, string>
  query: string
  selected: string | null
  onSelect: (id: string | null) => void
}) {
  const { t } = useI18n()
  const { resolvedTheme } = useTheme()
  const searching = query.trim() !== ""
  const matches = React.useMemo(
    () => new Set(searching ? allNodes(graph).filter((n) => nodeMatches(n, query)).map((n) => n.id) : []),
    [graph, query, searching]
  )
  const { nodes, edges } = React.useMemo(
    () => toFlow(graph, layout, titles, matches, searching, selected, t),
    [graph, layout, titles, matches, searching, selected, t]
  )

  return (
    <ReactFlow<TopologyFlowNode, RoutedFlowEdge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      colorMode={resolvedTheme === "dark" ? "dark" : "light"}
      fitView
      fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
      minZoom={0.05}
      maxZoom={2}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      edgesFocusable={false}
      onNodeClick={(_, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      zIndexMode="manual"
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        nodeColor={minimapColor}
        nodeStrokeWidth={0}
        style={{ width: 160, height: 110 }}
        className="!hidden sm:!block"
      />
      <Panel position="top-right" className="hidden md:block">
        <Legend />
      </Panel>
    </ReactFlow>
  )
}

function Toolbar({
  graph,
  filters,
  setFilters,
  query,
  setQuery,
  matchIds,
}: {
  graph: TopologyGraph
  filters: TopologyFilters
  setFilters: (f: TopologyFilters) => void
  query: string
  setQuery: (q: string) => void
  matchIds: string[]
}) {
  const i18n = useI18n()
  const text = i18n.t.topology.toolbar
  const { fitView } = useReactFlow()
  const hasStandalone = graph.containers.some((c) => c.project === null)
  const toggle = (key: "hideStopped" | "showBuiltinNetworks" | "showBindMounts", label: string) => (
    <div className="flex items-center gap-2">
      <Switch id={`topology-${key}`} checked={filters[key]} onCheckedChange={(v) => setFilters({ ...filters, [key]: v })} />
      <Label htmlFor={`topology-${key}`} className="text-sm font-normal whitespace-nowrap">
        {label}
      </Label>
    </div>
  )

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Select
        value={filters.project ?? ALL}
        onValueChange={(v) => setFilters({ ...filters, project: v === ALL ? null : v })}
      >
        <SelectTrigger className="w-56" aria-label={text.project}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{text.allProjects}</SelectItem>
          {graph.projects.length ? <SelectSeparator /> : null}
          {graph.projects.map((p) => (
            <SelectItem key={p.name} value={p.name}>
              {p.name} <span className="text-muted-foreground">({p.containerIds.length})</span>
            </SelectItem>
          ))}
          {hasStandalone ? (
            <>
              <SelectSeparator />
              <SelectItem value={STANDALONE}>{text.standalone}</SelectItem>
            </>
          ) : null}
        </SelectContent>
      </Select>
      <div className="relative w-64">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder={text.searchPlaceholder}
          aria-label={text.search}
          className="pl-8"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matchIds.length) {
              fitView({ nodes: matchIds.map((id) => ({ id })), duration: 400, padding: 0.3, maxZoom: 1.2 })
            }
          }}
        />
      </div>
      {query.trim() ? (
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {i18n.plural(text.matches, matchIds.length)}
        </span>
      ) : null}
      {toggle("hideStopped", text.hideStopped)}
      {toggle("showBuiltinNetworks", text.builtinNetworks)}
      {toggle("showBindMounts", text.bindMounts)}
    </div>
  )
}

export function TopologyView({ graph, initialProject }: { graph: TopologyGraph; initialProject: string | null }) {
  const i18n = useI18n()
  const { t } = i18n
  const mounted = useMounted()
  const known = initialProject !== null && (initialProject === STANDALONE || graph.projects.some((p) => p.name === initialProject))
  const [filters, setFiltersState] = React.useState<TopologyFilters>({ ...DEFAULT_FILTERS, project: known ? initialProject : null })
  const [notice, setNotice] = React.useState(initialProject !== null && !known ? initialProject : null)
  const [query, setQuery] = React.useState("")
  const [selected, setSelected] = React.useState<string | null>(null)

  const visible = React.useMemo(() => visibleTopology(graph, filters), [graph, filters])
  const layout = React.useMemo(() => layoutTopology(visible), [visible])
  const titles = React.useMemo(() => containerTitles(graph), [graph])
  const matchIds = React.useMemo(
    () => (query.trim() ? allNodes(visible).filter((n) => nodeMatches(n, query)).map((n) => n.id) : []),
    [visible, query]
  )
  const selectedNode = React.useMemo<TopologyNode | null>(
    () => (selected ? (allNodes(graph).find((n) => n.id === selected) ?? null) : null),
    [graph, selected]
  )

  function setFilters(next: TopologyFilters) {
    setFiltersState(next)
    setNotice(null)
    if (next.project !== filters.project) {
      const url = new URL(window.location.href)
      if (next.project) url.searchParams.set("project", next.project)
      else url.searchParams.delete("project")
      window.history.replaceState(null, "", url)
    }
  }

  const summary = t.topology.summary
  const hiddenStopped = filters.hideStopped
    ? graph.containers.filter((c) => !visible.containers.includes(c) && (filters.project === null || c.project === filters.project)).length
    : 0

  return (
    <ReactFlowProvider>
      <div className="grid gap-3 px-4 lg:px-6">
        <Toolbar graph={graph} filters={filters} setFilters={setFilters} query={query} setQuery={setQuery} matchIds={matchIds} />
        <p className="text-sm text-muted-foreground" data-testid="topology-summary">
          {[
            i18n.plural(summary.containers, visible.containers.length),
            i18n.plural(summary.projects, visible.projects.length),
            i18n.plural(summary.networks, visible.networks.length),
            i18n.plural(summary.volumes, visible.volumes.length),
            hiddenStopped ? i18n.format(summary.stoppedHidden, { count: hiddenStopped }) : null,
            graph.unused.volumes || graph.unused.networks
              ? i18n.format(summary.notShown, {
                  list: [
                    graph.unused.volumes ? i18n.plural(summary.unusedVolumes, graph.unused.volumes) : null,
                    graph.unused.networks ? i18n.plural(summary.unusedNetworks, graph.unused.networks) : null,
                  ]
                    .filter(Boolean)
                    .join(", "),
                })
              : null,
            notice ? i18n.format(summary.unknownProject, { name: notice }) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <div className="relative h-[calc(100svh-15rem)] min-h-[480px] overflow-hidden rounded-xl border bg-background" data-testid="topology-canvas">
          {!mounted ? (
            <Skeleton className="size-full rounded-none" />
          ) : visible.containers.length === 0 ? (
            <div className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
              {graph.containers.length ? t.topology.noMatch : t.topology.noContainers}
            </div>
          ) : (
            <Canvas
              key={JSON.stringify(filters)}
              graph={visible}
              layout={layout}
              titles={titles}
              query={query}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </div>
      </div>
      <Sheet modal={false} open={selectedNode !== null} onOpenChange={(open) => (open ? null : setSelected(null))}>
        <SheetContent
          className="gap-0 sm:max-w-md"
          data-testid="topology-details"
          onInteractOutside={(e) => {
            // Clicking another node switches the panel instead of closing it.
            if ((e.target as Element | null)?.closest?.(".react-flow__node")) e.preventDefault()
          }}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {selectedNode ? (
            <TopologyDetails
              graph={graph}
              node={selectedNode}
              onShowProject={(name) => {
                setSelected(null)
                setFilters({ ...filters, project: name })
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </ReactFlowProvider>
  )
}
