"use client"

import {
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  Position,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import { FolderIcon, HardDriveIcon, LayersIcon, NetworkIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { BindNode, ContainerNode, NetworkNode, ProjectNode, TopologyEdge, VolumeNode } from "@/lib/topology"
import { portBadges, type Point } from "@/lib/topology-layout"

// Same palette as StateBadge in components/gantry/ui.tsx.
export const STATE_DOT: Record<string, string> = {
  running: "bg-emerald-500",
  restarting: "bg-amber-500",
  paused: "bg-sky-500",
  created: "bg-muted-foreground",
  exited: "bg-red-500",
  dead: "bg-red-700",
  removing: "bg-amber-500",
}

export const STATE_COLOR: Record<string, string> = {
  running: "#10b981",
  restarting: "#f59e0b",
  paused: "#0ea5e9",
  exited: "#ef4444",
  dead: "#b91c1c",
  removing: "#f59e0b",
}

const NETWORK_HUES = [250, 160, 30, 300, 200, 95, 340, 130, 60, 280]

/** Stable per-network colour so a network's edges can be traced across the canvas. */
export function networkColor(name: string) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `oklch(0.62 0.15 ${NETWORK_HUES[h % NETWORK_HUES.length]})`
}

type Highlight = { dim?: boolean; match?: boolean; focus?: boolean }

export type ContainerFlowNode = Node<{ node: ContainerNode; title: string } & Highlight, "container">
export type NetworkFlowNode = Node<{ node: NetworkNode } & Highlight, "network">
export type VolumeFlowNode = Node<{ node: VolumeNode } & Highlight, "volume">
export type BindFlowNode = Node<{ node: BindNode } & Highlight, "bind">
export type ProjectFlowNode = Node<{ node: ProjectNode; running: number; total: number } & Highlight, "project">
export type TopologyFlowNode = ContainerFlowNode | NetworkFlowNode | VolumeFlowNode | BindFlowNode | ProjectFlowNode

const hidden = "!pointer-events-none !opacity-0 !min-h-0 !min-w-0 !size-px !border-0"

function shell({ dim, match, focus }: Highlight) {
  return cn(
    "h-full w-full rounded-lg border bg-card text-card-foreground shadow-xs transition-[opacity,box-shadow]",
    dim && "opacity-25",
    match && "ring-2 ring-amber-400 ring-offset-1 ring-offset-background",
    focus && "ring-2 ring-primary ring-offset-1 ring-offset-background"
  )
}

export function ContainerNodeView({ data }: NodeProps<ContainerFlowNode>) {
  const c = data.node
  const { shown, hidden: more } = portBadges(c.ports)
  const special = c.builtinNetworks.length ? c.builtinNetworks : c.networkMode?.startsWith("container:") ? ["shared net"] : []
  return (
    <div
      className={cn(shell(data), "flex cursor-pointer flex-col justify-center gap-1 px-3")}
      data-testid="topology-container"
      aria-label={`Container ${c.name}`}
      title={`${c.name} (${c.state})`}
    >
      <Handle type="target" position={Position.Left} className={hidden} isConnectable={false} />
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", STATE_DOT[c.state] ?? "bg-muted-foreground")} />
        <span className="truncate text-sm font-medium">{data.title}</span>
        {special.map((n) => (
          <span key={n} className="ml-auto shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground">
            {n}
          </span>
        ))}
      </div>
      <div className="truncate pl-4 font-mono text-[11px] text-muted-foreground">{c.image}</div>
      {shown.length ? (
        <div className="flex gap-1 overflow-hidden pl-4 whitespace-nowrap">
          {shown.map((p) => (
            <span key={`${p.label}@${p.ip}`} className="rounded bg-muted px-1 font-mono text-[10px] leading-4" title={p.ip ? `${p.ip}:${p.label}` : p.label}>
              {p.label}
            </span>
          ))}
          {more ? <span className="rounded bg-muted px-1 font-mono text-[10px] leading-4">+{more}</span> : null}
        </div>
      ) : null}
      <Handle type="source" position={Position.Right} className={hidden} isConnectable={false} />
    </div>
  )
}

function ResourceNode({
  icon,
  title,
  subtitle,
  data,
  kind,
  label,
  color,
  side,
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  data: Highlight
  kind: string
  label: string
  color?: string
  side: "source" | "target"
}) {
  return (
    <div
      className={cn(shell(data), "flex cursor-pointer items-center gap-2.5 px-3")}
      style={color ? { borderLeftColor: color, borderLeftWidth: 3 } : undefined}
      data-testid={`topology-${kind}`}
      aria-label={label}
      title={label}
    >
      {side === "source" ? (
        <Handle type="source" position={Position.Right} className={hidden} isConnectable={false} />
      ) : (
        <Handle type="target" position={Position.Left} className={hidden} isConnectable={false} />
      )}
      <span className="shrink-0 text-muted-foreground [&_svg]:size-4" style={color ? { color } : undefined}>
        {icon}
      </span>
      <div className="grid min-w-0">
        <span className="truncate text-[13px] font-medium">{title}</span>
        <span className="truncate text-[11px] text-muted-foreground">{subtitle}</span>
      </div>
    </div>
  )
}

export function NetworkNodeView({ data }: NodeProps<NetworkFlowNode>) {
  const n = data.node
  const subtitle = n.missing
    ? "not found"
    : [n.driver, n.subnets[0], n.internal ? "internal" : null].filter(Boolean).join(" · ")
  return (
    <ResourceNode
      icon={<NetworkIcon />}
      title={n.name}
      subtitle={subtitle}
      data={data}
      kind="network"
      label={`Network ${n.name}`}
      color={networkColor(n.name)}
      side="source"
    />
  )
}

/** Compose prefixes volumes with the project name; the rest is what tells them apart. */
export function volumeTitle(v: VolumeNode) {
  if (v.anonymous) return `${v.name.slice(0, 12)}…`
  if (v.project && v.name.startsWith(`${v.project}_`) && v.name.length > v.project.length + 1) return v.name.slice(v.project.length + 1)
  return v.name
}

export function VolumeNodeView({ data }: NodeProps<VolumeFlowNode>) {
  const v = data.node
  return (
    <ResourceNode
      icon={<HardDriveIcon />}
      title={volumeTitle(v)}
      subtitle={[v.driver, v.anonymous ? "anonymous" : null, v.missing ? "not found" : null, v.project].filter(Boolean).join(" · ")}
      data={data}
      kind="volume"
      label={`Volume ${v.name}`}
      side="target"
    />
  )
}

export function BindNodeView({ data }: NodeProps<BindFlowNode>) {
  const b = data.node
  const base = b.source.split("/").filter(Boolean).pop() ?? "/"
  return (
    <ResourceNode
      icon={<FolderIcon />}
      title={base}
      subtitle={b.source}
      data={data}
      kind="bind"
      label={`Bind mount ${b.source}`}
      side="target"
    />
  )
}

export function ProjectNodeView({ data }: NodeProps<ProjectFlowNode>) {
  const p = data.node
  return (
    <div
      className={cn(
        "relative h-full w-full rounded-xl border-2 border-dashed border-border bg-muted/30 transition-opacity",
        data.dim && "opacity-40",
        data.match && "border-amber-400",
        data.focus && "border-primary"
      )}
      data-testid="topology-project"
      aria-label={`Compose project ${p.name}`}
    >
      <div className="absolute -top-3 left-3 flex max-w-[calc(100%-1.5rem)] cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2 py-0.5 text-xs shadow-xs">
        <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-semibold">{p.name}</span>
        <span className="shrink-0 text-muted-foreground">
          {data.running}/{data.total} running
        </span>
      </div>
    </div>
  )
}

export const nodeTypes = {
  container: ContainerNodeView,
  network: NetworkNodeView,
  volume: VolumeNodeView,
  bind: BindNodeView,
  project: ProjectNodeView,
}

// ---------------------------------------------------------------------------
// Edges: drawn along dagre's route so they bend around nodes instead of
// cutting straight through them.

export type RoutedFlowEdge = Edge<
  {
    edge: TopologyEdge
    route: Point[]
    label: string | null
    color: string
    emphasis: "normal" | "focus" | "dim"
  },
  "routed"
>

/** Smooth curve with horizontal tangents through the interior route points. */
export function routePath(start: Point, interior: Point[], end: Point) {
  const pts = [start, ...interior, end]
  let d = `M ${start.x},${start.y}`
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const dx = (b.x - a.x) / 2
    d += ` C ${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`
  }
  return d
}

const STROKE: Record<TopologyEdge["kind"], { dash?: string; width: number }> = {
  network: { width: 1.5 },
  volume: { width: 1.25 },
  bind: { width: 1.25, dash: "2 4" },
  depends: { width: 1.75, dash: "6 4" },
  netns: { width: 1.5, dash: "3 3" },
}

const LABEL_ZOOM = 0.6

export function RoutedEdge({ id, sourceX, sourceY, targetX, targetY, data, markerEnd }: EdgeProps<RoutedFlowEdge>) {
  const zoomedIn = useStore((s) => s.transform[2] >= LABEL_ZOOM)
  if (!data) return null
  // Dagre's first/last points sit on node borders; the handles are on the sides.
  const interior = data.route.slice(1, -1).filter((p) => p.x > sourceX && p.x < targetX)
  const path = routePath({ x: sourceX, y: sourceY }, interior, { x: targetX, y: targetY })
  const style = STROKE[data.edge.kind]
  const focus = data.emphasis === "focus"
  const anchor = interior.at(-1) ?? { x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 }
  const showLabel = !!data.label && data.emphasis !== "dim" && (zoomedIn || focus)
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: data.color,
          strokeWidth: style.width * (focus ? 1.8 : 1),
          strokeDasharray: style.dash,
          opacity: data.emphasis === "dim" ? 0.15 : focus ? 1 : 0.75,
        }}
      />
      {showLabel ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute max-w-44 truncate rounded border bg-background/90 px-1 font-mono text-[10px] leading-4 text-muted-foreground"
            style={{ transform: `translate(-100%, -50%) translate(${anchor.x - 4}px, ${anchor.y}px)` }}
            data-testid={`topology-edge-label-${data.edge.kind}`}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export const edgeTypes = { routed: RoutedEdge }
