import "server-only"

import crypto from "node:crypto"
import type net from "node:net"

import {
  encodeData,
  encodeFrame,
  encodeJson,
  encodeReset,
  encodeWindow,
  FrameType,
  MAX_DATA,
  MAX_UPSTREAM_INFLIGHT,
  PROTOCOL_VERSION,
  ProtocolError,
  readWindow,
  ReceiveWindows,
  type AgentHello,
  type Frame,
  type RecvState,
} from "@/lib/agent/protocol"
import type { AgentInfo } from "@/lib/server/agent/info"
import type { LiveAgent } from "@/lib/server/agent/state"

export type SessionOptions = {
  environmentId: number
  environmentName: string
  /** Hash of the key the agent authenticated with; a rotation invalidates the session. */
  keyHash: string
  info: AgentInfo
  remoteAddress: string | null
  maxStreams: number
  /** Receive window per stream, in bytes. */
  window: number
  /** Largest window of a busy stream and the growth shared by all streams (agents that support it). */
  maxWindow: number
  windowPool: number
  heartbeatMs: number
  /** How long a connection waits for a free stream when maxStreams are in use (default 30 s). */
  queueMs?: number
  /** Called every few heartbeats; returning false ends the session (key rotated, environment deleted). */
  revalidate?: () => Promise<boolean>
  onClose?: (reason: string) => void
}

type Stream = {
  id: number
  conn: net.Socket
  /** Bytes we may still send before the agent grants more. */
  sendWindow: number
  /** What we received and granted back (flow control toward Gantry). */
  recv: RecvState
  /** We sent END (the local side finished writing). */
  localEnded: boolean
  /** The agent sent END. */
  remoteEnded: boolean
  /** RESET was received or sent: nothing more goes out for this stream. */
  reset: boolean
}

/** Every this many heartbeats, the key is checked against the database again. */
const REVALIDATE_EVERY = 6
/** Connections waiting for a free stream, per allowed stream. */
const QUEUE_PER_STREAM = 4
/** How long an upstream POST waits for the ones numbered before it. */
const UPSTREAM_ORDER_MS = 60_000

/**
 * Answers a local connection we won't tunnel with an HTTP error, so the
 * Docker client (or the compose CLI) shows why instead of "socket hang up".
 */
function refuse(conn: net.Socket, status: number, message: string) {
  if (conn.destroyed) return
  const body = JSON.stringify({ message })
  const reason = status === 503 ? "Service Unavailable" : "Bad Gateway"
  conn.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
  )
  setTimeout(() => conn.destroy(), 1000).unref?.()
}

/**
 * One connected agent: a downstream byte stream (the body of its GET
 * /api/agent/connect) and upstream frames (its POSTs), multiplexing one
 * tunneled stream per local Docker connection. Flow control is per stream:
 * each side sends at most `window` bytes beyond what the other granted, and
 * grants bytes back once they were written onward, so a slow reader on
 * either end pauses the writer on the other instead of filling memory.
 */
export class AgentSession implements LiveAgent {
  readonly id = crypto.randomUUID()
  readonly secret = crypto.randomBytes(32).toString("base64url")
  readonly connectedAt = new Date()
  readonly environmentId: number
  readonly keyHash: string
  readonly info: AgentInfo
  readonly remoteAddress: string | null
  readonly maxStreams: number
  readonly downstream: ReadableStream<Uint8Array>
  lastSeen = Date.now()
  rttMs: number | null = null
  closed = false
  closeReason = ""
  /** Upstream POSTs are numbered; the next one to apply carries this. */
  expectedSeq = 0
  /** Upstream POSTs the agent may have in flight (1 for agents that didn't offer more). */
  readonly upstreamInflight: number
  /** Totals, for the logs. */
  bytesDown = 0
  bytesUp = 0

  private readonly opts: SessionOptions
  private readonly streams = new Map<number, Stream>()
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null
  private nextStreamId = 1
  private heartbeat: ReturnType<typeof setInterval>
  private beats = 0
  /** Local connections waiting for a stream to free up. */
  private waiting: { conn: net.Socket; timer: ReturnType<typeof setTimeout> }[] = []
  private lastLimitWarning = 0
  private readonly windows: ReceiveWindows
  /** A batch is being applied. */
  private applying = false
  /** POSTs that arrived before their turn, by sequence number. */
  private early = new Map<number, (ok: boolean) => void>()

  constructor(opts: SessionOptions) {
    this.opts = opts
    this.environmentId = opts.environmentId
    this.keyHash = opts.keyHash
    this.info = opts.info
    this.remoteAddress = opts.remoteAddress
    this.maxStreams = opts.maxStreams
    // Concurrent POSTs and window growth only for agents that offer them.
    const offered = opts.info.upstreamInflight
    this.upstreamInflight = offered ? Math.min(offered, MAX_UPSTREAM_INFLIGHT) : 1
    this.windows = new ReceiveWindows(opts.window, offered ? opts.maxWindow : opts.window, opts.windowPool)
    this.downstream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller
      },
      cancel: () => this.close("the agent disconnected", { notify: false }),
    })
    const hello: AgentHello = {
      protocol: PROTOCOL_VERSION,
      session: this.id,
      secret: this.secret,
      environment: { id: opts.environmentId, name: opts.environmentName },
      maxStreams: opts.maxStreams,
      window: opts.window,
      maxData: MAX_DATA,
      heartbeatMs: opts.heartbeatMs,
      ...(offered ? { upstreamInflight: this.upstreamInflight, maxWindow: opts.maxWindow, windowPool: opts.windowPool } : {}),
    }
    this.send(encodeJson(FrameType.HELLO, 0, hello))
    this.heartbeat = setInterval(() => void this.beat(), opts.heartbeatMs)
    this.heartbeat.unref?.()
  }

  get streamCount() {
    return this.streams.size
  }

  private async beat() {
    if (this.closed) return
    // Upstream traffic (at least the PONGs) shows the agent is alive.
    if (Date.now() - this.lastSeen > this.opts.heartbeatMs * 3.5) {
      this.close("heartbeat timeout: nothing from the agent for too long", { notify: true })
      return
    }
    const ping = Buffer.alloc(8)
    ping.writeDoubleBE(Date.now(), 0)
    this.send(encodeFrame(FrameType.PING, 0, ping))
    if (++this.beats % REVALIDATE_EVERY === 0 && this.opts.revalidate) {
      try {
        if (!(await this.opts.revalidate())) this.close("the agent key was rotated or the environment was deleted", { retry: false })
      } catch (err) {
        console.warn(`[gantry] agent ${this.environmentId}: could not re-check its key: ${(err as Error).message}`)
      }
    }
  }

  private send(frame: Buffer) {
    if (this.closed || !this.controller) return
    try {
      this.controller.enqueue(frame)
      this.bytesDown += frame.length
    } catch {
      this.close("the downstream connection is gone", { notify: false })
    }
  }

  get queued() {
    return this.waiting.length
  }

  /**
   * Tunnels a local connection (from the environment's Unix socket) to the
   * agent's Docker socket. Beyond maxStreams it waits for a free stream (a
   * dashboard samples 30 containers at once), up to queueMs.
   */
  attach(conn: net.Socket) {
    if (this.closed) {
      refuse(conn, 502, "The agent of this environment is not connected")
      return
    }
    if (this.streams.size < this.maxStreams && !this.waiting.length) {
      this.open(conn)
      return
    }
    const limit = `Too many connections through the agent at once (limit ${this.maxStreams}, GANTRY_AGENT_MAX_STREAMS)`
    if (Date.now() - this.lastLimitWarning > 60_000) {
      this.lastLimitWarning = Date.now()
      console.warn(`[gantry] agent ${this.environmentId}: all ${this.maxStreams} streams in use; connections wait`)
    }
    if (this.waiting.length >= this.maxStreams * QUEUE_PER_STREAM) {
      refuse(conn, 503, `${limit}; try again later`)
      return
    }
    const entry = {
      conn,
      timer: setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== entry)
        refuse(conn, 503, `${limit}; gave up waiting for a free one`)
      }, this.opts.queueMs ?? 30_000),
    }
    entry.timer.unref?.()
    this.waiting.push(entry)
    conn.once("close", () => {
      clearTimeout(entry.timer)
      this.waiting = this.waiting.filter((w) => w !== entry)
    })
  }

  /** Opens streams for waiting connections while there is room. */
  private drain() {
    while (!this.closed && this.streams.size < this.maxStreams && this.waiting.length) {
      const { conn, timer } = this.waiting.shift()!
      clearTimeout(timer)
      if (!conn.destroyed) this.open(conn)
    }
  }

  private open(conn: net.Socket) {
    const id = this.allocateId()
    const s: Stream = {
      id,
      conn,
      sendWindow: this.opts.window,
      recv: this.windows.open(),
      localEnded: false,
      remoteEnded: false,
      reset: false,
    }
    this.streams.set(id, s)
    this.send(encodeFrame(FrameType.OPEN, id))

    conn.on("data", (chunk: Buffer) => {
      if (s.reset) return
      for (const frame of encodeData(id, chunk)) this.send(frame)
      s.sendWindow -= chunk.length
      if (s.sendWindow <= 0) conn.pause()
    })
    conn.on("end", () => {
      if (s.reset) return
      s.localEnded = true
      this.send(encodeFrame(FrameType.END, id))
    })
    conn.on("error", () => {
      // "close" follows and sends the RESET.
    })
    conn.on("close", () => {
      if (!s.reset && !(s.localEnded && s.remoteEnded)) {
        s.reset = true
        this.send(encodeReset(id, "closed by Gantry"))
      }
      this.forget(s)
      this.drain()
    })
  }

  private allocateId() {
    for (;;) {
      const id = this.nextStreamId
      this.nextStreamId = id >= 0xfffffff0 ? 1 : id + 1
      if (!this.streams.has(id)) return id
    }
  }

  /** Handles one frame from an upstream POST. Throws ProtocolError on a violation. */
  receive(frame: Frame) {
    if (this.closed) return
    this.lastSeen = Date.now()
    this.bytesUp += frame.payload.length + 9
    if (frame.stream === 0) {
      if (frame.type === FrameType.PONG) {
        if (frame.payload.length === 8) this.rttMs = Math.max(0, Date.now() - frame.payload.readDoubleBE(0))
        return
      }
      throw new ProtocolError(`Unexpected control frame ${frame.type} from the agent`)
    }
    const s = this.streams.get(frame.stream)
    // Frames for a stream that was just closed here are expected; drop them.
    if (!s) return
    switch (frame.type) {
      case FrameType.DATA: {
        if (s.reset || s.remoteEnded) return
        const n = frame.payload.length
        if (!this.windows.received(s.recv, n)) {
          this.resetStream(s, "flow control window exceeded")
          return
        }
        s.conn.write(frame.payload, () => {
          if (s.reset) return
          const grant = this.windows.consumed(s.recv, n)
          if (grant) this.send(encodeWindow(s.id, grant))
        })
        return
      }
      case FrameType.END:
        s.remoteEnded = true
        s.conn.end()
        return
      case FrameType.RESET:
        s.reset = true
        s.conn.destroy()
        this.forget(s)
        this.drain()
        return
      case FrameType.WINDOW:
        s.sendWindow += readWindow(frame)
        if (s.sendWindow > 0 && s.conn.isPaused()) s.conn.resume()
        return
      default:
        throw new ProtocolError(`Unexpected frame ${frame.type} on stream ${frame.stream}`)
    }
  }

  private resetStream(s: Stream, reason: string) {
    if (!s.reset) {
      s.reset = true
      this.send(encodeReset(s.id, reason))
    }
    s.conn.destroy()
    this.forget(s)
    this.drain()
  }

  /** Drops a stream; its window growth goes back to the pool. */
  private forget(s: Stream) {
    if (this.streams.get(s.id) !== s) return
    this.streams.delete(s.id)
    this.windows.close(s.recv)
  }

  /** Window growth not handed out to streams right now (for tests and the logs). */
  get windowPoolAvailable() {
    return this.windows.available
  }

  /**
   * Waits until upstream batch `seq` may be applied: all before it were.
   * The agent may have `upstreamInflight` POSTs in flight, so they can
   * arrive out of order. False when `seq` is outside that range, already
   * waiting, or the session ends first; the caller then ends the session.
   */
  async upstreamTurn(seq: number): Promise<boolean> {
    if (this.closed || !Number.isSafeInteger(seq) || seq < this.expectedSeq || seq >= this.expectedSeq + this.upstreamInflight) return false
    if (this.early.has(seq)) return false
    if (seq === this.expectedSeq) {
      // Not while it is being applied: that would be a replay.
      if (this.applying) return false
      this.applying = true
      return true
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.early.delete(seq)
        resolve(false)
      }, UPSTREAM_ORDER_MS)
      timer.unref?.()
      this.early.set(seq, (ok) => {
        clearTimeout(timer)
        this.early.delete(seq)
        if (ok) this.applying = true
        resolve(ok)
      })
    })
  }

  /** The current upstream batch was applied: the next one may go. */
  upstreamDone() {
    this.applying = false
    this.expectedSeq++
    this.early.get(this.expectedSeq)?.(true)
  }

  /**
   * Ends the session: tells the agent why (GOAWAY, unless the connection is
   * already gone), drops every tunneled connection and ends the downstream.
   * `retry: false` tells the agent its key is no longer valid.
   */
  close(reason: string, opts: { notify?: boolean; retry?: boolean } = {}) {
    if (this.closed) return
    if (opts.notify !== false) this.send(encodeJson(FrameType.GOAWAY, 0, { reason, retry: opts.retry ?? true }))
    this.closed = true
    this.closeReason = reason
    clearInterval(this.heartbeat)
    for (const s of this.streams.values()) {
      s.reset = true
      s.conn.destroy()
    }
    this.streams.clear()
    for (const wake of [...this.early.values()]) wake(false)
    for (const { conn, timer } of this.waiting) {
      clearTimeout(timer)
      refuse(conn, 502, `The agent disconnected: ${reason}`)
    }
    this.waiting = []
    try {
      this.controller?.close()
    } catch {
      // Already closed or cancelled by the client.
    }
    this.opts.onClose?.(reason)
  }
}
