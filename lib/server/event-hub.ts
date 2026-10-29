import type { LiveEvent } from "@/lib/live"

/**
 * Fan-out of one upstream event stream per key (environment) to any number
 * of subscribers (open browser tabs). The upstream is opened by the first
 * subscriber, closed shortly after the last one leaves, and reopened with
 * exponential backoff whenever it drops while someone is still listening.
 *
 * Kept free of Docker/Next specifics so it can be unit tested with a fake
 * source; see lib/server/docker/events.ts for the real one.
 */

export type HubStatus = "connecting" | "connected" | "reconnecting"

export type HubMessage = { kind: "event"; event: LiveEvent } | { kind: "status"; status: HubStatus }

export type HubListener = (message: HubMessage) => void

/**
 * Opens the upstream stream. Calls `onOpen` once connected and `onEvent` per
 * event; the promise settles when the stream ends (resolve) or fails
 * (reject). Must stop promptly when `signal` aborts.
 */
export type HubSource = (
  handlers: { onOpen: () => void; onEvent: (event: LiveEvent) => void },
  signal: AbortSignal
) => Promise<void>

export type EventHubOptions = {
  /** First reconnect delay; doubles per failed attempt. */
  initialBackoffMs?: number
  maxBackoffMs?: number
  /** A connection that stayed up this long resets the backoff. */
  stableAfterMs?: number
  /** Keep the upstream open this long after the last subscriber leaves (tab reloads). */
  lingerMs?: number
  onError?: (key: string, err: unknown) => void
  onConnect?: (key: string) => void
}

type Channel = {
  key: string
  source: HubSource
  listeners: Set<HubListener>
  status: HubStatus
  abort: AbortController | null
  openedAt: number | null
  attempt: number
  retryTimer: ReturnType<typeof setTimeout> | null
  lingerTimer: ReturnType<typeof setTimeout> | null
}

export class EventHub {
  private channels = new Map<string, Channel>()
  private opts: Required<Omit<EventHubOptions, "onError" | "onConnect">> &
    Pick<EventHubOptions, "onError" | "onConnect">

  constructor(opts: EventHubOptions = {}) {
    this.opts = {
      initialBackoffMs: opts.initialBackoffMs ?? 1_000,
      maxBackoffMs: opts.maxBackoffMs ?? 30_000,
      stableAfterMs: opts.stableAfterMs ?? 10_000,
      lingerMs: opts.lingerMs ?? 5_000,
      onError: opts.onError,
      onConnect: opts.onConnect,
    }
  }

  /** Adds a listener for `key`; returns the unsubscribe function. */
  subscribe(key: string, source: HubSource, listener: HubListener): () => void {
    let channel = this.channels.get(key)
    if (!channel) {
      channel = {
        key,
        source,
        listeners: new Set(),
        status: "connecting",
        abort: null,
        openedAt: null,
        attempt: 0,
        retryTimer: null,
        lingerTimer: null,
      }
      this.channels.set(key, channel)
    }
    if (channel.lingerTimer) {
      clearTimeout(channel.lingerTimer)
      channel.lingerTimer = null
    }
    channel.listeners.add(listener)
    safeCall(listener, { kind: "status", status: channel.status })
    if (!channel.abort && !channel.retryTimer) this.connect(channel)

    const ch = channel
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      ch.listeners.delete(listener)
      if (ch.listeners.size > 0 || this.channels.get(ch.key) !== ch) return
      if (this.opts.lingerMs <= 0) this.close(ch)
      else ch.lingerTimer = setTimeout(() => this.close(ch), this.opts.lingerMs)
    }
  }

  /** Number of open upstream connections (for tests and diagnostics). */
  get upstreamCount() {
    let n = 0
    for (const ch of this.channels.values()) if (ch.abort) n++
    return n
  }

  listenerCount(key: string) {
    return this.channels.get(key)?.listeners.size ?? 0
  }

  private connect(channel: Channel) {
    channel.retryTimer = null
    const abort = new AbortController()
    channel.abort = abort
    channel.openedAt = null

    const current = () => channel.abort === abort && this.channels.get(channel.key) === channel
    let ended = false
    const end = (err?: unknown) => {
      if (ended || !current()) return
      ended = true
      if (err !== undefined) this.opts.onError?.(channel.key, err)
      this.reconnectLater(channel)
    }

    let promise: Promise<void>
    try {
      promise = channel.source(
        {
          onOpen: () => {
            if (!current() || ended) return
            channel.openedAt = Date.now()
            this.opts.onConnect?.(channel.key)
            this.setStatus(channel, "connected")
          },
          onEvent: (event) => {
            if (!current() || ended) return
            for (const l of [...channel.listeners]) safeCall(l, { kind: "event", event })
          },
        },
        abort.signal
      )
    } catch (err) {
      promise = Promise.reject(err)
    }
    promise.then(
      () => end(),
      (err) => end(err ?? new Error("event stream failed"))
    )
  }

  private reconnectLater(channel: Channel) {
    channel.abort = null
    if (channel.openedAt !== null && Date.now() - channel.openedAt >= this.opts.stableAfterMs) {
      channel.attempt = 0
    }
    channel.openedAt = null
    if (channel.listeners.size === 0) {
      this.close(channel)
      return
    }
    this.setStatus(channel, "reconnecting")
    const delay = Math.min(this.opts.maxBackoffMs, this.opts.initialBackoffMs * 2 ** channel.attempt)
    channel.attempt++
    channel.retryTimer = setTimeout(() => this.connect(channel), delay)
  }

  private close(channel: Channel) {
    if (channel.retryTimer) clearTimeout(channel.retryTimer)
    if (channel.lingerTimer) clearTimeout(channel.lingerTimer)
    channel.retryTimer = null
    channel.lingerTimer = null
    const abort = channel.abort
    channel.abort = null
    if (this.channels.get(channel.key) === channel) this.channels.delete(channel.key)
    abort?.abort()
  }

  private setStatus(channel: Channel, status: HubStatus) {
    if (channel.status === status) return
    channel.status = status
    for (const l of [...channel.listeners]) safeCall(l, { kind: "status", status })
  }
}

function safeCall(listener: HubListener, message: HubMessage) {
  try {
    listener(message)
  } catch {
    // A broken subscriber (closed stream) must not affect the others.
  }
}
