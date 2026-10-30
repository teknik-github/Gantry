// Live updates: which Docker events are worth refreshing a page for.
// Shared by the server (filtering the Docker /events stream) and the browser
// (deciding whether the current page cares), so keep it free of Node APIs.

export type LiveEventType = "container" | "image" | "volume" | "network"

/** What /api/events sends to the browser for one Docker event. */
export type DockerLiveEvent = {
  type: LiveEventType
  action: string
  /** Actor id: container/image/network id, or the volume name. */
  id: string
  name?: string
  /** For network connect/disconnect: the container that was attached. */
  container?: string
}

/** State-changing actions per object type. Everything else (exec_*, health_status, top, attach, mount, ...) is noise. */
/** Kubernetes resource types watched for live updates (lib/server/kubernetes/watch.ts). */
export type KubeWatchKind =
  | "Pod"
  | "Deployment"
  | "StatefulSet"
  | "DaemonSet"
  | "Service"
  | "Ingress"
  | "Event"
  | "Namespace"

/**
 * One change from a Kubernetes watch. "resync" means the watch had to start
 * over and changes may have been missed: refresh whatever shows that kind.
 */
export type KubeLiveEvent = {
  type: "kubernetes"
  kind: KubeWatchKind
  action: "added" | "modified" | "deleted" | "resync"
  namespace?: string
  name?: string
}

export type LiveEvent = DockerLiveEvent | KubeLiveEvent

export const RELEVANT_ACTIONS: Record<LiveEventType, readonly string[]> = {
  container: ["create", "start", "restart", "stop", "die", "kill", "pause", "unpause", "rename", "update", "destroy", "prune"],
  image: ["pull", "delete", "tag", "untag", "import", "load", "prune"],
  volume: ["create", "destroy", "prune"],
  network: ["create", "connect", "disconnect", "destroy", "remove", "prune"],
}

/** `filters` for Docker's GET /events, so the daemon drops most noise before it reaches us. */
export const DOCKER_EVENT_FILTERS = {
  type: Object.keys(RELEVANT_ACTIONS),
  event: [...new Set(Object.values(RELEVANT_ACTIONS).flat())],
}

type RawDockerEvent = {
  Type?: unknown
  Action?: unknown
  Actor?: { ID?: unknown; Attributes?: Record<string, unknown> | null } | null
}

/** Maps a raw Docker event to a LiveEvent, or null when it should be ignored. */
export function toLiveEvent(raw: unknown): DockerLiveEvent | null {
  if (!raw || typeof raw !== "object") return null
  const ev = raw as RawDockerEvent
  if (typeof ev.Type !== "string" || typeof ev.Action !== "string") return null
  if (!(ev.Type in RELEVANT_ACTIONS)) return null
  const type = ev.Type as LiveEventType
  // Some actions carry details after a colon ("exec_start: sh", "health_status: healthy").
  const action = ev.Action.split(":")[0].trim()
  if (!RELEVANT_ACTIONS[type].includes(action)) return null

  const id = typeof ev.Actor?.ID === "string" ? ev.Actor.ID : ""
  const attrs = ev.Actor?.Attributes ?? {}
  const out: DockerLiveEvent = { type, action, id }
  if (typeof attrs.name === "string") out.name = attrs.name
  if (type === "network" && typeof attrs.container === "string") out.container = attrs.container
  return out
}

// Pages that show no Docker state, so Docker events never refresh them
// (Kubernetes pages follow Kubernetes events instead).
const NON_DOCKER_PAGES = new Set([
  "users",
  "account",
  "activity",
  "environments",
  "registries",
  "templates",
  "notifications",
  "kubernetes",
])

// Containers being created or removed changes usage counts on the object lists.
const containerAddedOrRemoved = (e: DockerLiveEvent) =>
  e.type === "container" && (e.action === "create" || e.action === "destroy" || e.action === "prune")

// What each list page shows; pages not listed (dashboard, stacks, ...) take every event.
const LIST_PAGES: Record<string, (e: DockerLiveEvent) => boolean> = {
  containers: (e) => e.type === "container",
  images: (e) => e.type === "image" || containerAddedOrRemoved(e),
  volumes: (e) => e.type === "volume" || containerAddedOrRemoved(e),
  networks: (e) => e.type === "network" || containerAddedOrRemoved(e),
}

// Which watched kinds each Kubernetes page (/kubernetes/<page>) shows.
const KUBE_PAGES: Record<string, readonly KubeWatchKind[]> = {
  "": ["Pod", "Event", "Namespace"],
  workloads: ["Deployment", "StatefulSet", "DaemonSet"],
  pods: ["Pod"],
  services: ["Service", "Ingress"],
  namespaces: ["Namespace"],
  events: ["Event"],
}

function kubeEventAffects(event: KubeLiveEvent, segments: string[]): boolean {
  const kinds = KUBE_PAGES[segments[0] ?? ""]
  if (!kinds?.includes(event.kind)) return false
  // A pod's own page only cares about that pod.
  if (segments[0] === "pods" && segments[1] && segments[2] && event.action !== "resync") {
    return event.namespace === decodeURIComponent(segments[1]) && event.name === decodeURIComponent(segments[2])
  }
  return true
}

/** Whether an event can change what the page at `pathname` shows. */
export function eventAffectsPath(event: LiveEvent, pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean)
  if (event.type === "kubernetes") return segments[0] === "kubernetes" && kubeEventAffects(event, segments.slice(1))
  if (NON_DOCKER_PAGES.has(segments[0] ?? "")) return false

  // A container's own page only cares about that container.
  if (segments[0] === "containers" && segments[1]) {
    const id = segments[1].toLowerCase()
    const matches = (other?: string) => Boolean(other) && (other!.startsWith(id) || id.startsWith(other!))
    if (event.type === "container") return matches(event.id)
    if (event.type === "network") return matches(event.container)
    return false
  }
  const page = LIST_PAGES[segments[0] ?? ""]
  return page ? page(event) : true
}
