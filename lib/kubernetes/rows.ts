import type {
  ConfigMap,
  Ingress,
  KubeEvent,
  Namespace,
  Node,
  Pod,
  SecretSummary,
  Service,
  Workload,
} from "@/lib/server/kubernetes/api"
import type { WorkloadKind } from "@/lib/kubernetes/names"

// Turns Kubernetes objects into the display rows sent to the browser. Rows
// only carry display fields (never Secret values or credentials). Pure, so
// it is unit tested and shared by the pages.

export type PodRow = {
  id: string
  name: string
  namespace: string
  /** kubectl-style status: Running, Pending, CrashLoopBackOff, Completed, Terminating, ... */
  status: string
  ready: string
  restarts: number
  node: string
  ip: string
  created: string
  containers: string[]
}

export type WorkloadRow = {
  id: string
  kind: WorkloadKind
  name: string
  namespace: string
  ready: number
  desired: number
  upToDate: number
  images: string[]
  created: string
}

export type ServiceRow = {
  id: string
  name: string
  namespace: string
  type: string
  clusterIP: string
  ports: string[]
  externalIPs: string[]
  created: string
}

export type IngressRow = {
  id: string
  name: string
  namespace: string
  className: string
  hosts: string[]
  address: string[]
  created: string
}

export type NamespaceRow = { name: string; status: string; created: string }

export type ConfigMapRow = { id: string; name: string; namespace: string; keys: string[]; created: string }

export type SecretRow = { id: string; name: string; namespace: string; type: string; keys: string[]; created: string }

export type EventRow = {
  id: string
  namespace: string
  type: string
  reason: string
  object: string
  message: string
  count: number
  lastSeen: string
}

export type NodeRow = {
  name: string
  ready: boolean
  schedulable: boolean
  roles: string[]
  version: string
  internalIP: string
  os: string
  created: string
}

const key = (ns: string | undefined, name: string) => `${ns ?? ""}/${name}`

/** Status the way `kubectl get pods` shows it. */
export function podStatus(pod: Pod): string {
  if (pod.metadata.deletionTimestamp) return "Terminating"
  const st = pod.status ?? {}
  if (st.reason) return st.reason // e.g. Evicted

  for (const [i, c] of (st.initContainerStatuses ?? []).entries()) {
    const t = c.state?.terminated
    if (t && t.exitCode === 0) continue
    if (t) return t.reason ? `Init:${t.reason}` : `Init:ExitCode:${t.exitCode ?? "?"}`
    const reason = c.state?.waiting?.reason
    if (reason && reason !== "PodInitializing") return `Init:${reason}`
    return `Init:${i}/${st.initContainerStatuses!.length}`
  }

  let status = st.phase ?? "Unknown"
  let running = false
  for (const c of st.containerStatuses ?? []) {
    if (c.state?.waiting?.reason) status = c.state.waiting.reason
    else if (c.state?.terminated) status = c.state.terminated.reason ?? `ExitCode:${c.state.terminated.exitCode ?? "?"}`
    else if (c.state?.running && c.ready) running = true
  }
  if (status === "Completed" && running) status = "Running"
  return status
}

export function toPodRows(pods: Pod[]): PodRow[] {
  return pods.map((p) => {
    const statuses = p.status?.containerStatuses ?? []
    const containers = (p.spec?.containers ?? []).map((c) => c.name)
    return {
      id: key(p.metadata.namespace, p.metadata.name),
      name: p.metadata.name,
      namespace: p.metadata.namespace ?? "",
      status: podStatus(p),
      ready: `${statuses.filter((c) => c.ready).length}/${containers.length || statuses.length}`,
      restarts: statuses.reduce((n, c) => n + (c.restartCount ?? 0), 0),
      node: p.spec?.nodeName ?? "",
      ip: p.status?.podIP ?? "",
      created: p.metadata.creationTimestamp ?? "",
      containers,
    }
  })
}

/** Pods counted by phase (Running, Pending, Succeeded, Failed, Unknown). */
export function podsByPhase(pods: Pod[]): Record<string, number> {
  const out: Record<string, number> = { Running: 0, Pending: 0, Succeeded: 0, Failed: 0, Unknown: 0 }
  for (const p of pods) {
    const phase = p.status?.phase ?? "Unknown"
    out[phase] = (out[phase] ?? 0) + 1
  }
  return out
}

export function toWorkloadRows(kind: WorkloadKind, items: Workload[]): WorkloadRow[] {
  return items.map((w) => {
    const st = w.status ?? {}
    const daemon = kind === "DaemonSet"
    return {
      id: `${kind}/${key(w.metadata.namespace, w.metadata.name)}`,
      kind,
      name: w.metadata.name,
      namespace: w.metadata.namespace ?? "",
      ready: (daemon ? st.numberReady : st.readyReplicas) ?? 0,
      desired: (daemon ? st.desiredNumberScheduled : w.spec?.replicas) ?? 0,
      upToDate: (daemon ? st.updatedNumberScheduled : st.updatedReplicas) ?? 0,
      images: [...new Set((w.spec?.template?.spec?.containers ?? []).map((c) => c.image ?? "").filter(Boolean))],
      created: w.metadata.creationTimestamp ?? "",
    }
  })
}

function lbAddresses(lb?: { ingress?: { ip?: string; hostname?: string }[] }) {
  return (lb?.ingress ?? []).map((i) => i.ip || i.hostname || "").filter(Boolean)
}

export function toServiceRows(services: Service[]): ServiceRow[] {
  return services.map((s) => ({
    id: key(s.metadata.namespace, s.metadata.name),
    name: s.metadata.name,
    namespace: s.metadata.namespace ?? "",
    type: s.spec?.type ?? "ClusterIP",
    clusterIP: s.spec?.clusterIP ?? "",
    ports: (s.spec?.ports ?? []).map((p) => {
      const proto = p.protocol && p.protocol !== "TCP" ? `/${p.protocol}` : ""
      const target = p.targetPort !== undefined && String(p.targetPort) !== String(p.port) ? `→${p.targetPort}` : ""
      return `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}${target}${proto}`
    }),
    externalIPs: [...(s.spec?.externalIPs ?? []), ...lbAddresses(s.status?.loadBalancer), ...(s.spec?.externalName ? [s.spec.externalName] : [])],
    created: s.metadata.creationTimestamp ?? "",
  }))
}

export function toIngressRows(ingresses: Ingress[]): IngressRow[] {
  return ingresses.map((i) => ({
    id: key(i.metadata.namespace, i.metadata.name),
    name: i.metadata.name,
    namespace: i.metadata.namespace ?? "",
    className: i.spec?.ingressClassName ?? "",
    hosts: [...new Set((i.spec?.rules ?? []).map((r) => r.host || "*"))],
    address: lbAddresses(i.status?.loadBalancer),
    created: i.metadata.creationTimestamp ?? "",
  }))
}

export function toNamespaceRows(namespaces: Namespace[]): NamespaceRow[] {
  return namespaces.map((n) => ({
    name: n.metadata.name,
    status: n.status?.phase ?? "Active",
    created: n.metadata.creationTimestamp ?? "",
  }))
}

export function toConfigMapRows(items: ConfigMap[]): ConfigMapRow[] {
  return items.map((c) => ({
    id: key(c.metadata.namespace, c.metadata.name),
    name: c.metadata.name,
    namespace: c.metadata.namespace ?? "",
    keys: [...Object.keys(c.data ?? {}), ...Object.keys(c.binaryData ?? {})].sort(),
    created: c.metadata.creationTimestamp ?? "",
  }))
}

export function toSecretRows(items: SecretSummary[]): SecretRow[] {
  return items.map((s) => ({
    id: key(s.metadata.namespace, s.metadata.name),
    name: s.metadata.name,
    namespace: s.metadata.namespace ?? "",
    type: s.type ?? "Opaque",
    keys: [...s.keys].sort(),
    created: s.metadata.creationTimestamp ?? "",
  }))
}

/** Newest first. */
export function toEventRows(events: KubeEvent[]): EventRow[] {
  return events
    .map((e) => ({
      id: e.metadata.uid ?? key(e.metadata.namespace, e.metadata.name),
      namespace: e.metadata.namespace ?? "",
      type: e.type ?? "Normal",
      reason: e.reason ?? "",
      object: [e.involvedObject?.kind, e.involvedObject?.name].filter(Boolean).join("/"),
      message: e.message ?? "",
      count: e.count ?? 1,
      lastSeen: e.lastTimestamp ?? e.eventTime ?? e.firstTimestamp ?? e.metadata.creationTimestamp ?? "",
    }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
}

export function toNodeRows(nodes: Node[]): NodeRow[] {
  return nodes.map((n) => ({
    name: n.metadata.name,
    ready: (n.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
    schedulable: !n.spec?.unschedulable,
    roles: Object.keys(n.metadata.labels ?? {})
      .filter((l) => l.startsWith("node-role.kubernetes.io/"))
      .map((l) => l.slice("node-role.kubernetes.io/".length) || "node"),
    version: n.status?.nodeInfo?.kubeletVersion ?? "",
    internalIP: n.status?.addresses?.find((a) => a.type === "InternalIP")?.address ?? "",
    os: n.status?.nodeInfo?.osImage ?? "",
    created: n.metadata.creationTimestamp ?? "",
  }))
}
