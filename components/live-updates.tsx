"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"

import { eventAffectsPath, type LiveEvent } from "@/lib/live"
import { cn } from "@/lib/utils"

const DEBOUNCE_MS = 750
// Under a constant stream of events, still refresh at least this often.
const MAX_WAIT_MS = 3_000
const MAX_RETRY_MS = 30_000
const STUCK_REFRESH_MS = 60_000
const LOADING_POLL_MS = 500

type LiveStatus = "idle" | "connecting" | "connected" | "reconnecting"

// Tiny store shared by <LiveUpdates /> (writer) and <LiveIndicator /> (reader).
let liveStatus: LiveStatus = "idle"
const statusListeners = new Set<() => void>()

function setLiveStatus(status: LiveStatus) {
  if (status === liveStatus) return
  liveStatus = status
  for (const l of statusListeners) l()
}

function subscribeStatus(listener: () => void) {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

function useLiveStatus() {
  return React.useSyncExternalStore(
    subscribeStatus,
    () => liveStatus,
    () => "idle" as LiveStatus
  )
}

/**
 * Keeps server-rendered pages in sync with Docker: listens to /api/events and
 * calls router.refresh() (debounced) when something relevant to the current
 * page changes. refresh() re-renders Server Components only, so client state
 * (search boxes, open dialogs, the console and log viewer) is kept.
 * `environmentId` changes when the user switches environment, which reconnects.
 */
export function LiveUpdates({ environmentId }: { environmentId: number | null }) {
  const router = useRouter()
  const pathname = usePathname()
  const pathRef = React.useRef(pathname)
  // Refreshes are throttled so a busy Docker host can't starve the page:
  // - one at a time: a refresh runs as a transition, and requests made while
  //   it is pending collapse into a single follow-up;
  // - never while the route's loading fallback is on screen (first load or a
  //   refresh still streaming in), or each refresh would restart the page's
  //   dynamic render and it would never appear.
  const [refreshing, startRefresh] = React.useTransition()
  const refreshingRef = React.useRef(false)
  const startedAtRef = React.useRef(0)
  const owedRef = React.useRef(false)
  const waitTimerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const requestRefresh = React.useCallback(
    function request() {
      clearTimeout(waitTimerRef.current)
      // The age check is only a safety net in case a pending state is never reported.
      const busy = refreshingRef.current && performance.now() - startedAtRef.current < STUCK_REFRESH_MS
      if (busy || document.querySelector("[data-route-loading]")) {
        owedRef.current = true
        if (!busy) waitTimerRef.current = setTimeout(request, LOADING_POLL_MS)
        return
      }
      owedRef.current = false
      refreshingRef.current = true
      startedAtRef.current = performance.now()
      startRefresh(() => router.refresh())
    },
    [router]
  )

  React.useEffect(() => {
    pathRef.current = pathname
  }, [pathname])

  React.useEffect(() => {
    refreshingRef.current = refreshing
    if (!refreshing && owedRef.current) requestRefresh()
  }, [refreshing, requestRefresh])

  React.useEffect(() => () => clearTimeout(waitTimerRef.current), [])

  React.useEffect(() => {
    if (environmentId === null) return

    let source: EventSource | null = null
    let disposed = false
    let attempt = 0
    // Events may have been missed while disconnected: refresh once back.
    let missedEvents = false
    let refreshWhenVisible = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    let maxWaitTimer: ReturnType<typeof setTimeout> | undefined

    const refresh = () => {
      clearTimeout(debounceTimer)
      clearTimeout(maxWaitTimer)
      debounceTimer = maxWaitTimer = undefined
      if (disposed) return
      // Background tabs catch up when they become visible again.
      if (document.hidden) refreshWhenVisible = true
      else requestRefresh()
    }

    const scheduleRefresh = () => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(refresh, DEBOUNCE_MS)
      maxWaitTimer ??= setTimeout(refresh, MAX_WAIT_MS)
    }

    const onVisibility = () => {
      if (!document.hidden && refreshWhenVisible) {
        refreshWhenVisible = false
        requestRefresh()
      }
    }

    const lost = () => {
      missedEvents = true
      setLiveStatus("reconnecting")
    }

    // EventSource hides the HTTP status, so ask separately why it gave up.
    const probe = async () => {
      try {
        const res = await fetch("/api/events?probe=1", { cache: "no-store" })
        if (disposed) return
        if (res.status === 401) {
          router.replace("/login")
          return
        }
      } catch {
        // Offline or server down: retry below.
      }
      if (disposed) return
      retryTimer = setTimeout(open, Math.min(MAX_RETRY_MS, 1_000 * 2 ** attempt++))
    }

    function open() {
      if (disposed) return
      const es = new EventSource("/api/events")
      source = es
      if (liveStatus === "idle") setLiveStatus("connecting")

      es.addEventListener("status", (e) => {
        const { status } = JSON.parse((e as MessageEvent).data) as { status: string }
        if (status === "connected") {
          attempt = 0
          setLiveStatus("connected")
          if (missedEvents) {
            missedEvents = false
            scheduleRefresh()
          }
        } else if (status === "reconnecting") {
          lost() // Gantry is up but can't reach Docker / the cluster.
        }
      })
      const onEvent = (e: Event) => {
        const event = JSON.parse((e as MessageEvent).data) as LiveEvent
        if (eventAffectsPath(event, pathRef.current)) scheduleRefresh()
      }
      es.addEventListener("docker", onEvent)
      es.addEventListener("kubernetes", onEvent)
      // Planned close by the server: reopen right away without a refresh.
      es.addEventListener("rotate", () => {
        es.close()
        open()
      })
      es.onerror = () => {
        if (source !== es) return
        lost()
        // CONNECTING: the browser retries by itself. CLOSED: it gave up (e.g. a 401).
        if (es.readyState === EventSource.CLOSED) {
          es.close()
          void probe()
        }
      }
    }

    open()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      disposed = true
      source?.close()
      clearTimeout(retryTimer)
      clearTimeout(debounceTimer)
      clearTimeout(maxWaitTimer)
      document.removeEventListener("visibilitychange", onVisibility)
      setLiveStatus("idle")
    }
  }, [environmentId, router, requestRefresh])

  return null
}

const LABELS: Record<LiveStatus, string> = {
  idle: "",
  connecting: "Connecting",
  connected: "Live",
  reconnecting: "Reconnecting",
}

const TITLES: Record<LiveStatus, string> = {
  idle: "",
  connecting: "Connecting to live updates…",
  connected: "Pages update automatically when the environment changes",
  reconnecting: "Live updates interrupted; reconnecting…",
}

/** Small connection badge for the site header. */
export function LiveIndicator({ className }: { className?: string }) {
  const status = useLiveStatus()
  if (status === "idle") return null
  return (
    <span
      data-testid="live-indicator"
      data-status={status}
      title={TITLES[status]}
      role="status"
      className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}
    >
      <span className="relative flex size-2">
        {status === "connected" ? (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-50 [animation-duration:2.5s]" />
        ) : null}
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            status === "connected" && "bg-emerald-500",
            status === "connecting" && "bg-muted-foreground/50",
            status === "reconnecting" && "animate-pulse bg-amber-500"
          )}
        />
      </span>
      <span className="hidden sm:inline">{LABELS[status]}</span>
    </span>
  )
}
