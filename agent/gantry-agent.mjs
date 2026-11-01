#!/usr/bin/env node
// Gantry agent: lets Gantry manage the Docker host it runs on without
// exposing the Docker API. It dials OUT to Gantry over HTTP(S) and carries
// Gantry's Docker connections to the local Docker socket, and nowhere else.
//
//   docker run -d --name gantry-agent --restart unless-stopped --user root \
//     -v /var/run/docker.sock:/var/run/docker.sock \
//     -e GANTRY_URL=https://gantry.example.com -e GANTRY_AGENT_KEY=gak_… \
//     gantry:latest agent
//
// Settings (environment variables):
//   GANTRY_URL             Gantry's address (https://…; http:// only for loopback)
//   GANTRY_AGENT_KEY       the enrollment key shown when the environment was added
//   GANTRY_AGENT_INSECURE  "1": allow plain http:// to a non-loopback address
//   GANTRY_AGENT_CA        CA certificate(s) to trust for Gantry: PEM text or a file path
//   DOCKER_SOCKET          local Docker socket (default /var/run/docker.sock)
//   GANTRY_AGENT_DEBUG     "1": log every tunneled connection
//   GANTRY_AGENT_HEALTH_FILE  refreshed while connected, for the image's HEALTHCHECK
//                          (default /tmp/gantry-agent.health)
//
// Protocol (lib/agent/protocol.ts in Gantry; keep both in sync): a long GET
// /api/agent/connect carries frames from Gantry, numbered POSTs to
// /api/agent/upstream carry frames back. No dependencies: Node.js >= 20.

import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import { pathToFileURL } from "node:url"

export const AGENT_VERSION = "1.0.0"
export const PROTOCOL_VERSION = 1

// ------------------------------------------------------------------- frames

export const FrameType = { HELLO: 1, OPEN: 2, DATA: 3, END: 4, RESET: 5, WINDOW: 6, PING: 7, PONG: 8, GOAWAY: 9 }
export const HEADER_BYTES = 9
export const MAX_DATA = 64 * 1024
export const MAX_CONTROL = 4 * 1024
const TYPES = new Set(Object.values(FrameType))

export class ProtocolError extends Error {
  constructor(message) {
    super(message)
    this.name = "ProtocolError"
  }
}

const maxPayload = (type) => (type === FrameType.DATA ? MAX_DATA : MAX_CONTROL)

/** @param {number} type @param {number} stream @param {Uint8Array} [payload] */
export function encodeFrame(type, stream, payload = Buffer.alloc(0)) {
  if (!Number.isInteger(stream) || stream < 0 || stream > 0xffffffff) throw new ProtocolError(`Invalid stream id ${stream}`)
  if (payload.length > maxPayload(type)) throw new ProtocolError(`Frame payload too large (${payload.length} bytes)`)
  const frame = Buffer.allocUnsafe(HEADER_BYTES + payload.length)
  frame.writeUInt8(type, 0)
  frame.writeUInt32BE(stream, 1)
  frame.writeUInt32BE(payload.length, 5)
  frame.set(payload, HEADER_BYTES)
  return frame
}

/** Incremental frame decoder; throws ProtocolError on unknown types and oversized frames. */
export class FrameDecoder {
  constructor() {
    /** @type {Buffer[]} */
    this.chunks = []
    this.buffered = 0
  }

  /** @param {Uint8Array} chunk @returns {{ type: number, stream: number, payload: Buffer }[]} */
  push(chunk) {
    if (chunk.length) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length))
      this.buffered += chunk.length
    }
    const frames = []
    while (this.buffered >= HEADER_BYTES) {
      if (this.chunks[0].length < HEADER_BYTES) this.chunks = [Buffer.concat(this.chunks)]
      const head = this.chunks[0]
      const type = head.readUInt8(0)
      const stream = head.readUInt32BE(1)
      const length = head.readUInt32BE(5)
      if (!TYPES.has(type)) throw new ProtocolError(`Unknown frame type ${type}`)
      if (length > maxPayload(type)) throw new ProtocolError(`Frame payload too large (${length} bytes)`)
      const total = HEADER_BYTES + length
      if (this.buffered < total) break
      if (this.chunks[0].length < total) this.chunks = [Buffer.concat(this.chunks)]
      const first = this.chunks[0]
      frames.push({ type, stream, payload: first.subarray(HEADER_BYTES, total) })
      if (first.length === total) this.chunks.shift()
      else this.chunks[0] = first.subarray(total)
      this.buffered -= total
    }
    return frames
  }

  get pending() {
    return this.buffered
  }
}

// ------------------------------------------------------------------ settings

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

/**
 * Reads and checks the settings. Throws an Error with a message meant for
 * the person running the agent.
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
  const rawUrl = (env.GANTRY_URL ?? "").trim()
  const key = (env.GANTRY_AGENT_KEY ?? "").trim()
  if (!rawUrl) throw new Error("GANTRY_URL is not set (Gantry's address, e.g. https://gantry.example.com)")
  if (!key) throw new Error("GANTRY_AGENT_KEY is not set (the enrollment key shown when the environment was added)")
  if (!/^gak_[1-9][0-9]{0,9}_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("GANTRY_AGENT_KEY is malformed; copy it again from Gantry")
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`GANTRY_URL is not a valid URL: ${rawUrl}`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("GANTRY_URL must start with https:// (or http://)")
  if (url.username || url.password) throw new Error("GANTRY_URL must not contain credentials")
  const insecure = env.GANTRY_AGENT_INSECURE === "1" || env.GANTRY_AGENT_INSECURE === "true"
  if (url.protocol === "http:" && !LOOPBACK.has(url.hostname) && !insecure) {
    throw new Error(
      "Refusing plain http:// to a remote Gantry: the key and all Docker traffic would travel unencrypted. Serve Gantry over https://, or set GANTRY_AGENT_INSECURE=1 on a network you trust."
    )
  }
  let ca
  const caSetting = (env.GANTRY_AGENT_CA ?? "").trim()
  if (caSetting) {
    ca = caSetting.startsWith("-----BEGIN") ? caSetting : fs.readFileSync(caSetting, "utf8")
    if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error("GANTRY_AGENT_CA holds no PEM certificate")
  }
  const base = url.href.replace(/\/+$/, "")
  return {
    base,
    url,
    key,
    insecure,
    ca,
    socket: (env.DOCKER_SOCKET ?? "").trim() || "/var/run/docker.sock",
    debug: env.GANTRY_AGENT_DEBUG === "1",
    /** @type {string | null} */
    healthFile: (env.GANTRY_AGENT_HEALTH_FILE ?? "").trim() || null,
  }
}

// ------------------------------------------------------------------- logging

/** @type {(level: string, message: string) => void} */
let logSink = (level, message) => {
  const line = `${new Date().toISOString()} [gantry-agent] ${level.padEnd(5)} ${message}`
  if (level === "error" || level === "warn") console.error(line)
  else console.log(line)
}
export function setLogger(fn) {
  logSink = fn
}
const log = {
  info: (m) => logSink("info", m),
  warn: (m) => logSink("warn", m),
  error: (m) => logSink("error", m),
  debug: (m) => logSink("debug", m),
}

// ------------------------------------------------------------- local docker

/** GET a JSON document from the local Docker socket. */
function dockerGet(socket, path, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path, method: "GET", headers: { Host: "docker" }, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        if ((res.statusCode ?? 500) >= 400) return reject(new Error(`Docker ${path}: HTTP ${res.statusCode} ${text.slice(0, 200)}`))
        try {
          resolve(JSON.parse(text))
        } catch {
          reject(new Error(`Docker ${path}: invalid JSON`))
        }
      })
      res.on("error", reject)
    })
    req.on("timeout", () => req.destroy(new Error(`Docker ${path}: timed out`)))
    req.on("error", reject)
    req.end()
  })
}

/** The container this agent runs in, from /proc (empty outside a container). */
function ownContainerCandidates() {
  const ids = new Set()
  for (const file of ["/proc/self/mountinfo", "/proc/self/cgroup"]) {
    let text = ""
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const m of text.matchAll(/\/containers\/([a-f0-9]{64})\/(?:hostname|hosts|resolv\.conf)/g)) ids.add(m[1])
    for (const m of text.matchAll(/(?:\/docker\/|docker-|libpod-)([a-f0-9]{64})/g)) ids.add(m[1])
  }
  return [...ids]
}

/** What Gantry shows about this host; fails when Docker can't be reached. */
export async function hostInfo(socket) {
  const [version, info] = await Promise.all([dockerGet(socket, "/version"), dockerGet(socket, "/info")])
  let containerId = null
  for (const id of ownContainerCandidates()) {
    try {
      const c = await dockerGet(socket, `/containers/${id}/json`)
      if (c && c.Id === id) {
        containerId = id
        break
      }
    } catch {
      // Not a container of this daemon.
    }
  }
  return {
    version: AGENT_VERSION,
    protocol: PROTOCOL_VERSION,
    hostname: String(info?.Name ?? ""),
    dockerVersion: String(version?.Version ?? ""),
    os: String(info?.OperatingSystem ?? version?.Os ?? ""),
    arch: String(version?.Arch ?? ""),
    containerId,
  }
}

// ------------------------------------------------------------------ session

const MAX_BATCH = 1024 * 1024
const MAX_QUEUED = 64 * 1024 * 1024

/**
 * One connection to Gantry: the downstream GET, the upstream POSTs and the
 * tunneled streams. Resolves when it ends, with why and whether to retry.
 */
export class Session {
  /**
   * @param {ReturnType<typeof loadConfig>} config
   * @param {{ httpAgent: http.Agent }} transport
   */
  constructor(config, transport) {
    this.config = config
    this.transport = transport
    /** @type {Map<number, any>} */
    this.streams = new Map()
    /** @type {Buffer[]} */
    this.queue = []
    this.queued = 0
    this.seq = 0
    this.inflight = false
    this.ended = false
    this.hello = null
    this.window = 1024 * 1024
    this.maxStreams = 64
    this.heartbeatMs = 10_000
    this.opened = 0
    this.decoder = new FrameDecoder()
    this.result = new Promise((resolve) => (this.finish = resolve))
  }

  /** Connects; resolves { reason, retry, connected } when the session is over. */
  async run(info) {
    const { config } = this
    const mod = config.url.protocol === "https:" ? https : http
    const req = mod.request(`${config.base}/api/agent/connect`, {
      method: "GET",
      agent: false,
      ca: config.ca,
      headers: {
        Authorization: `Bearer ${config.key}`,
        "X-Gantry-Agent-Info": Buffer.from(JSON.stringify(info)).toString("base64url"),
        Accept: "application/octet-stream",
        "User-Agent": `gantry-agent/${AGENT_VERSION}`,
      },
    })
    this.request = req
    req.on("response", (res) => {
      this.response = res
      if (res.statusCode !== 200) {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () => {
          let message = Buffer.concat(chunks).toString("utf8").slice(0, 500)
          try {
            message = JSON.parse(message).error ?? message
          } catch {}
          const retryAfter = Number(res.headers["retry-after"])
          this.end(`Gantry answered ${res.statusCode}: ${message}`, {
            retry: true,
            status: res.statusCode,
            retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
          })
        })
        return
      }
      res.socket?.setKeepAlive?.(true, 15_000)
      this.touch()
      res.on("data", (chunk) => {
        this.touch()
        let frames
        try {
          frames = this.decoder.push(chunk)
        } catch (err) {
          this.end(`protocol error from Gantry: ${err.message}`, { retry: true })
          return
        }
        for (const f of frames) {
          if (this.ended) return
          try {
            this.handle(f)
          } catch (err) {
            this.end(`protocol error: ${err.message}`, { retry: true })
            return
          }
        }
      })
      res.on("end", () => this.end("Gantry closed the connection", { retry: true }))
      res.on("error", (err) => this.end(`downstream failed: ${err.message}`, { retry: true }))
    })
    req.on("error", (err) => this.end(`cannot reach Gantry: ${err.code ?? err.message}`, { retry: true }))
    req.end()
    // Also bounds the wait for Gantry's answer.
    this.touch()
    return this.result
  }

  /** Marks the agent healthy for the container's HEALTHCHECK (connected, heard from Gantry). */
  healthy() {
    if (!this.config.healthFile) return
    try {
      fs.writeFileSync(this.config.healthFile, `${new Date().toISOString()}\n`)
    } catch {
      // Health reporting is best effort.
    }
  }

  touch() {
    clearTimeout(this.idleTimer)
    // Gantry pings every heartbeat; silence for much longer means a dead path.
    this.idleTimer = setTimeout(() => this.end("no heartbeat from Gantry; reconnecting", { retry: true }), this.heartbeatMs * 3.5)
  }

  handle(f) {
    const T = FrameType
    if (f.stream === 0) {
      switch (f.type) {
        case T.HELLO: {
          const hello = JSON.parse(f.payload.toString("utf8"))
          if (hello.protocol !== PROTOCOL_VERSION) throw new ProtocolError(`Gantry speaks protocol ${hello.protocol}`)
          this.hello = hello
          this.window = hello.window
          this.maxStreams = hello.maxStreams
          this.heartbeatMs = hello.heartbeatMs
          this.touch()
          this.connectedAt = Date.now()
          this.healthy()
          log.info(`connected to ${this.config.base} as environment "${hello.environment.name}" (id ${hello.environment.id})`)
          return
        }
        case T.PING:
          this.send(encodeFrame(T.PONG, 0, f.payload))
          this.healthy()
          return
        case T.GOAWAY: {
          let body = { reason: "", retry: true }
          try {
            body = JSON.parse(f.payload.toString("utf8"))
          } catch {}
          this.end(`Gantry ended the session: ${body.reason}`, { retry: body.retry !== false, goaway: true })
          return
        }
        default:
          throw new ProtocolError(`unexpected control frame ${f.type}`)
      }
    }
    if (!this.hello) throw new ProtocolError("frame before HELLO")
    if (f.type === T.OPEN) return this.open(f.stream)
    const s = this.streams.get(f.stream)
    if (!s) return // already closed here
    switch (f.type) {
      case T.DATA: {
        if (s.reset || s.remoteEnded) return
        const n = f.payload.length
        s.outstanding += n
        if (s.outstanding > this.window + MAX_DATA) return this.resetStream(s, "flow control window exceeded")
        s.sock.write(f.payload, () => {
          s.credit += n
          if (s.credit >= this.window / 4 && !s.reset) {
            const p = Buffer.allocUnsafe(4)
            p.writeUInt32BE(s.credit, 0)
            this.send(encodeFrame(T.WINDOW, s.id, p))
            s.outstanding -= s.credit
            s.credit = 0
          }
        })
        return
      }
      case T.END:
        s.remoteEnded = true
        s.sock.end()
        return
      case T.RESET:
        s.reset = true
        s.sock.destroy()
        this.streams.delete(s.id)
        return
      case T.WINDOW: {
        if (f.payload.length !== 4) throw new ProtocolError("bad WINDOW frame")
        s.sendWindow += f.payload.readUInt32BE(0)
        if (s.sendWindow > 0 && s.sock.isPaused()) s.sock.resume()
        return
      }
      default:
        throw new ProtocolError(`unexpected frame ${f.type} on stream ${f.stream}`)
    }
  }

  /** A new tunneled connection: only ever to the local Docker socket. */
  open(id) {
    if (id === 0 || this.streams.has(id)) throw new ProtocolError(`bad stream id ${id}`)
    // Gantry enforces maxStreams. A stream that ended cleanly can still be
    // closing here when Gantry already reuses its slot, so this is only a
    // safety bound with room for that.
    if (this.streams.size >= this.maxStreams * 2 + 16) {
      this.send(encodeFrame(FrameType.RESET, id, Buffer.from("too many connections through the agent")))
      return
    }
    const sock = net.connect({ path: this.config.socket, allowHalfOpen: true })
    const s = { id, sock, sendWindow: this.window, outstanding: 0, credit: 0, localEnded: false, remoteEnded: false, reset: false }
    this.streams.set(id, s)
    this.opened++
    if (this.config.debug) log.debug(`stream ${id} opened (${this.streams.size} open)`)
    sock.on("data", (chunk) => {
      if (s.reset) return
      for (let off = 0; off < chunk.length; off += MAX_DATA) {
        this.send(encodeFrame(FrameType.DATA, id, chunk.subarray(off, off + MAX_DATA)))
      }
      s.sendWindow -= chunk.length
      if (s.sendWindow <= 0) sock.pause()
    })
    sock.on("end", () => {
      if (s.reset) return
      s.localEnded = true
      this.send(encodeFrame(FrameType.END, id))
    })
    sock.on("error", (err) => {
      if (!s.reset) {
        s.reset = true
        log.warn(`Docker socket ${this.config.socket}: ${err.code ?? err.message}`)
        this.send(encodeFrame(FrameType.RESET, id, Buffer.from(`agent: Docker socket error ${err.code ?? err.message}`.slice(0, MAX_CONTROL))))
      }
    })
    sock.on("close", () => {
      if (!s.reset && !(s.localEnded && s.remoteEnded)) {
        s.reset = true
        this.send(encodeFrame(FrameType.RESET, id, Buffer.from("closed by the agent")))
      }
      this.streams.delete(id)
      if (this.config.debug) log.debug(`stream ${id} closed (${this.streams.size} open)`)
    })
  }

  resetStream(s, reason) {
    if (!s.reset) {
      s.reset = true
      this.send(encodeFrame(FrameType.RESET, s.id, Buffer.from(reason)))
    }
    s.sock.destroy()
    this.streams.delete(s.id)
  }

  /** Queues a frame for the next upstream POST. */
  send(frame) {
    if (this.ended) return
    this.queue.push(frame)
    this.queued += frame.length
    if (this.queued > MAX_QUEUED) {
      this.end("upstream queue overflow", { retry: true })
      return
    }
    if (!this.inflight && !this.flushScheduled) {
      this.flushScheduled = true
      // Collect what the same tick produces into one POST.
      setImmediate(() => {
        this.flushScheduled = false
        this.flush()
      })
    }
  }

  flush() {
    if (this.ended || this.inflight || !this.queue.length || !this.hello) return
    const parts = []
    let size = 0
    while (this.queue.length && (size === 0 || size + this.queue[0].length <= MAX_BATCH)) {
      const f = this.queue.shift()
      parts.push(f)
      size += f.length
    }
    this.queued -= size
    const body = Buffer.concat(parts, size)
    const seq = this.seq++
    this.inflight = true
    const mod = this.config.url.protocol === "https:" ? https : http
    const req = mod.request(`${this.config.base}/api/agent/upstream`, {
      method: "POST",
      agent: this.transport.httpAgent,
      ca: this.config.ca,
      headers: {
        Authorization: `Bearer ${this.hello.secret}`,
        "X-Gantry-Agent-Session": this.hello.session,
        "X-Gantry-Agent-Seq": String(seq),
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
        "User-Agent": `gantry-agent/${AGENT_VERSION}`,
      },
      timeout: 60_000,
    })
    req.on("response", (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => {
        this.inflight = false
        if (res.statusCode !== 204) {
          let message = Buffer.concat(chunks).toString("utf8").slice(0, 300)
          try {
            message = JSON.parse(message).error ?? message
          } catch {}
          this.end(`upstream refused (${res.statusCode}): ${message}`, { retry: true })
          return
        }
        this.flush()
      })
    })
    req.on("timeout", () => req.destroy(new Error("timed out")))
    req.on("error", (err) => {
      this.inflight = false
      this.end(`upstream failed: ${err.code ?? err.message}`, { retry: true })
    })
    req.end(body)
  }

  /** Ends the session once; drops every tunneled connection. */
  end(reason, opts) {
    if (this.ended) return
    this.ended = true
    clearTimeout(this.idleTimer)
    for (const s of this.streams.values()) {
      s.reset = true
      s.sock.destroy()
    }
    this.streams.clear()
    this.queue = []
    this.queued = 0
    this.request?.destroy()
    this.response?.destroy()
    if (this.config.healthFile) fs.rmSync(this.config.healthFile, { force: true })
    this.finish({ reason, connected: Boolean(this.hello), connectedFor: this.connectedAt ? Date.now() - this.connectedAt : 0, ...opts })
  }

  /** Ends the session from outside (shutdown). */
  stop(reason = "stopping") {
    this.end(reason, { retry: false })
  }
}

// --------------------------------------------------------------------- main

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true })
  })

/** Reconnect delay: exponential with jitter, longer when the key is refused. */
export function backoffDelay(attempt, outcome) {
  if (outcome?.retryAfterMs) return Math.min(outcome.retryAfterMs, 15 * 60_000)
  // A rejected key won't fix itself quickly: retry slowly, in case it was restored.
  if (outcome?.status === 401 || outcome?.status === 403 || outcome?.retry === false) return 5 * 60_000
  if (outcome?.status === 426) return 10 * 60_000
  const base = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000)
  return Math.round(base / 2 + Math.random() * (base / 2))
}

/**
 * Connects and reconnects until `signal` aborts. `onSession` lets tests see
 * the live session.
 */
export async function runAgent(config, { signal, onSession } = {}) {
  // Upstream POSTs reuse connections. Idle ones are dropped after 4 s, before
  // the usual 5 s keep-alive timeout of Node servers, so a POST never goes out
  // on a connection the server is just closing.
  const httpAgent = new (config.url.protocol === "https:" ? https : http).Agent({ keepAlive: true, maxSockets: 2, timeout: 4000, ca: config.ca })
  let attempt = 0
  log.info(`gantry-agent ${AGENT_VERSION} starting: Gantry ${config.base}, Docker ${config.socket}`)
  if (config.url.protocol === "http:") {
    log.warn("Gantry is reached over plain http://: traffic is not encrypted" + (config.insecure ? " (GANTRY_AGENT_INSECURE=1)" : " (loopback only)"))
  }
  while (!signal?.aborted) {
    let info
    try {
      info = await hostInfo(config.socket)
    } catch (err) {
      const delay = backoffDelay(attempt++)
      log.error(`cannot reach Docker at ${config.socket}: ${err.code ?? err.message}; retrying in ${Math.round(delay / 1000)}s`)
      await sleep(delay, signal)
      continue
    }
    const session = new Session(config, { httpAgent })
    onSession?.(session)
    const stop = () => session.stop("agent stopping")
    signal?.addEventListener("abort", stop, { once: true })
    const outcome = await session.run(info)
    signal?.removeEventListener("abort", stop)
    if (signal?.aborted) break
    if (outcome.connected) {
      log.warn(`disconnected after ${Math.round(outcome.connectedFor / 1000)}s: ${outcome.reason}`)
      // A session that lasted resets the backoff.
      if (outcome.connectedFor > 60_000) attempt = 0
    } else {
      log.error(outcome.reason)
    }
    if (outcome.status === 401) log.error("the key was refused: it was rotated or the environment was deleted. Run the agent with the current key from Gantry.")
    const delay = backoffDelay(attempt++, outcome)
    log.info(`reconnecting in ${Math.round(delay / 1000)}s`)
    await sleep(delay, signal)
  }
  httpAgent.destroy()
  log.info("stopped")
}

async function main() {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    log.error(err.message)
    process.exit(2)
  }
  config.healthFile ??= "/tmp/gantry-agent.health"
  const controller = new AbortController()
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log.info(`${sig} received`)
      controller.abort()
      setTimeout(() => process.exit(0), 3000).unref()
    })
  }
  await runAgent(config, { signal: controller.signal })
  process.exit(0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.error(err.stack ?? String(err))
    process.exit(1)
  })
}
