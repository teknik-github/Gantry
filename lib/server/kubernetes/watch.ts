import "server-only"

import type { KubeLiveEvent, KubeWatchKind } from "@/lib/live"
import type { HubSource } from "@/lib/server/event-hub"
import { KubeError, kubeJson, kubeStream, type KubeTarget } from "@/lib/server/kubernetes/client"

/**
 * Live updates for Kubernetes pages: one watch per resource type below,
 * shared by every open tab through the EventHub (lib/server/live-events.ts),
 * so an environment costs at most WATCHED.length API connections no matter
 * how many browsers look at it.
 *
 * Each watch starts from the resourceVersion of a list, follows bookmarks,
 * re-watches when the server ends the stream (timeoutSeconds) and re-lists
 * after "410 Gone" (the version fell out of the watch cache), telling the
 * pages to refresh because changes may have been missed. Connection errors
 * end the whole source; the hub reconnects with exponential backoff.
 */

type Watched = { kind: KubeWatchKind; group: string; resource: string }

export const WATCHED: readonly Watched[] = [
  { kind: "Pod", group: "v1", resource: "pods" },
  { kind: "Deployment", group: "apps/v1", resource: "deployments" },
  { kind: "StatefulSet", group: "apps/v1", resource: "statefulsets" },
  { kind: "DaemonSet", group: "apps/v1", resource: "daemonsets" },
  { kind: "Service", group: "v1", resource: "services" },
  { kind: "Ingress", group: "networking.k8s.io/v1", resource: "ingresses" },
  { kind: "Event", group: "v1", resource: "events" },
  { kind: "Namespace", group: "v1", resource: "namespaces" },
]

/** The server ends each watch after this long; we then re-watch from the last version. */
const WATCH_SECONDS = 290
/** No bytes (not even a bookmark) for this long means the connection is dead. */
const IDLE_TIMEOUT_MS = (WATCH_SECONDS + 40) * 1000
/** Watches ending sooner than this in a row point at a problem; give up and let the hub back off. */
const QUICK_END_MS = 1_000
const MAX_QUICK_ENDS = 5
const MAX_LINE_BYTES = 16 * 1024 * 1024

export type WatchEvent = {
  type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR"
  object: {
    metadata?: { name?: string; namespace?: string; resourceVersion?: string }
    // ERROR events carry a Status.
    code?: number
    reason?: string
    message?: string
  }
}

/** How a watch talks to the API; replaced by a fake in unit tests. */
export type WatchTransport = {
  /** Lists the collection and returns its resourceVersion. */
  list(signal: AbortSignal): Promise<string>
  /**
   * Watches from `resourceVersion`, calling `onEvent` per event, and resolves
   * when the stream ends. `onEvent` returns false to stop early.
   */
  watch(resourceVersion: string, onEvent: (event: WatchEvent) => boolean | void, signal: AbortSignal): Promise<void>
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
  })

const ACTIONS = { ADDED: "added", MODIFIED: "modified", DELETED: "deleted" } as const

/**
 * Follows one resource type until `signal` aborts, emitting a KubeLiveEvent
 * per change and a "resync" after re-listing. Rejects on errors other than
 * 410 Gone (and when watches keep ending immediately).
 */
export async function runWatch(
  transport: WatchTransport,
  kind: KubeWatchKind,
  emit: (event: KubeLiveEvent) => void,
  signal: AbortSignal,
  opts: { quickEndMs?: number; now?: () => number; resourceVersion?: string } = {}
): Promise<void> {
  const now = opts.now ?? Date.now
  const quickEndMs = opts.quickEndMs ?? QUICK_END_MS
  let resourceVersion = opts.resourceVersion ?? (await transport.list(signal))
  let quickEnds = 0

  while (!signal.aborted) {
    let gone = false
    let failure: KubeError | null = null
    const started = now()

    await transport.watch(
      resourceVersion,
      (event) => {
        const rv = event.object?.metadata?.resourceVersion
        if (event.type === "BOOKMARK") {
          if (rv) resourceVersion = rv
          return
        }
        if (event.type === "ERROR") {
          if (event.object?.code === 410) gone = true
          else failure = new KubeError(event.object?.message || `watch of ${kind} failed`, event.object?.code ?? 500, event.object?.reason)
          return false
        }
        const action = ACTIONS[event.type]
        if (!action) return
        if (rv) resourceVersion = rv
        const meta = event.object?.metadata ?? {}
        emit({ type: "kubernetes", kind, action, namespace: meta.namespace, name: meta.name })
      },
      signal
    )
    if (signal.aborted) return
    if (failure) throw failure

    if (gone) {
      // Too old for the watch cache: start over from a fresh list.
      resourceVersion = await transport.list(signal)
      emit({ type: "kubernetes", kind, action: "resync" })
      quickEnds = 0
      continue
    }

    if (now() - started < quickEndMs) {
      if (++quickEnds >= MAX_QUICK_ENDS) throw new KubeError(`watch of ${kind} keeps ending immediately`, 502)
      await sleep(quickEndMs, signal)
    } else {
      quickEnds = 0
    }
  }
}

/** Splits a newline-delimited JSON stream into parsed objects. */
export function ndjsonSplitter(onObject: (value: unknown) => void) {
  let pending = ""
  return {
    push(chunk: string) {
      pending += chunk
      if (pending.length > MAX_LINE_BYTES) throw new KubeError("A watch event is too large", 502)
      let nl: number
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).trim()
        pending = pending.slice(nl + 1)
        if (line) onObject(JSON.parse(line))
      }
    },
  }
}

function collectionPath(group: string, resource: string, namespace: string | null) {
  const prefix = group === "v1" ? "/api/v1" : `/apis/${group}`
  return namespace ? `${prefix}/namespaces/${encodeURIComponent(namespace)}/${resource}` : `${prefix}/${resource}`
}

/** The real transport: list with limit=1 (only the version is needed), then a streaming watch. */
export function httpTransport(target: KubeTarget, path: string): WatchTransport {
  return {
    async list() {
      const { data } = await kubeJson<{ metadata?: { resourceVersion?: string } }>(target, {
        method: "GET",
        path,
        query: { limit: 1 },
      })
      return data.metadata?.resourceVersion ?? "0"
    },
    async watch(resourceVersion, onEvent, signal) {
      const res = await kubeStream(
        target,
        {
          method: "GET",
          path,
          query: { watch: 1, resourceVersion, allowWatchBookmarks: true, timeoutSeconds: WATCH_SECONDS },
          idleTimeoutMs: IDLE_TIMEOUT_MS,
        },
        signal
      )
      await new Promise<void>((resolve, reject) => {
        let done = false
        const finish = (err?: unknown) => {
          if (done) return
          done = true
          res.destroy()
          if (err && !signal.aborted) reject(err instanceof KubeError ? err : new KubeError((err as Error).message, 502))
          else resolve()
        }
        const splitter = ndjsonSplitter((value) => {
          if (onEvent(value as WatchEvent) === false) finish()
        })
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          try {
            splitter.push(chunk)
          } catch (err) {
            finish(err)
          }
        })
        res.on("end", () => finish())
        res.on("error", (err) => finish(err))
        // A connection that drops without "end" (reset, idle timeout) is an error.
        res.on("close", () => finish(res.complete ? undefined : new KubeError("The watch connection was lost", 502)))
      })
    },
  }
}

/**
 * Hub source for one cluster: watches every type in WATCHED cluster-wide.
 * Types the credentials may not watch cluster-wide fall back to
 * `fallbackNamespace` (the environment's default namespace), or are skipped.
 */
export function kubeEventSource(target: KubeTarget, opts: { fallbackNamespace: string | null }): HubSource {
  return ({ onOpen, onEvent }, signal) =>
    new Promise<void>((resolve, reject) => {
      const inner = new AbortController()
      const stop = () => inner.abort()
      signal.addEventListener("abort", stop, { once: true })

      let opened = 0
      let settled = false
      const fail = (err: unknown) => {
        if (settled) return
        settled = true
        inner.abort()
        reject(err)
      }
      const markOpen = () => {
        if (++opened === WATCHED.length) onOpen()
      }

      const run = async (w: Watched) => {
        let transport = httpTransport(target, collectionPath(w.group, w.resource, null))
        let resourceVersion: string
        try {
          resourceVersion = await transport.list(inner.signal)
        } catch (err) {
          if (!(err instanceof KubeError) || err.status !== 403) throw err
          if (w.kind === "Namespace" || !opts.fallbackNamespace) {
            markOpen() // Not allowed: no live updates for this type.
            return
          }
          transport = httpTransport(target, collectionPath(w.group, w.resource, opts.fallbackNamespace))
          try {
            resourceVersion = await transport.list(inner.signal)
          } catch (err2) {
            if (err2 instanceof KubeError && err2.status === 403) {
              markOpen()
              return
            }
            throw err2
          }
        }
        markOpen()
        await runWatch(transport, w.kind, onEvent, inner.signal, { resourceVersion })
      }

      Promise.all(WATCHED.map((w) => run(w).catch(fail))).then(() => {
        if (settled) return
        // Every allowed watch runs until aborted; with none allowed, wait for the end.
        if (!signal.aborted) {
          signal.addEventListener(
            "abort",
            () => {
              settled = true
              resolve()
            },
            { once: true }
          )
        } else {
          settled = true
          resolve()
        }
      })
    })
}
