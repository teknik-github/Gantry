import "server-only"

import http from "node:http"
import type net from "node:net"
import { duplexPair, type Duplex } from "node:stream"

import { MAX_DATA } from "@/lib/agent/protocol"
import { AGENT_NOT_CONNECTED, agentState } from "@/lib/server/agent/state"

/**
 * In-process connections into an agent's tunnel, for Gantry's own Docker
 * client. They behave like connections to the environment's Unix socket
 * (agentSocketPath, which the docker compose CLI still uses), but the bytes
 * go straight between the HTTP client and the session as the same Buffers:
 * no write into the kernel and read back out, and no fresh buffer per read,
 * which on a busy Gantry cost about as much CPU as the transfer itself.
 *
 * Flow control is unchanged: a write into the pair completes when the other
 * end has read it, so the session grants window to the agent as the HTTP
 * client consumes data, and a request body waits while the agent's window
 * is used up.
 */

type SocketMethods = Pick<net.Socket, "setTimeout" | "setNoDelay" | "setKeepAlive" | "ref" | "unref">

/**
 * Gives `end` the net.Socket methods Node's HTTP client and agent (and
 * Gantry's exec and event streams) call on a connection; setTimeout fires
 * "timeout" after that long without data either way, as on a socket.
 */
function socketLike(end: Duplex): net.Socket {
  let idleMs = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  // Data either way restarts the idle timer (push: from the session, _write: to it).
  const push = end.push.bind(end)
  end.push = (chunk: unknown, encoding?: BufferEncoding) => {
    timer?.refresh()
    return push(chunk, encoding)
  }
  // Writes go to the session in pieces of at most what a socket read
  // returns: it sends what it gets and pauses once the agent's window is
  // used up, so one large write (a whole request body) would overrun it.
  const write = end._write.bind(end)
  end._write = (chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
    timer?.refresh()
    if (chunk.length <= MAX_DATA) return write(chunk, encoding, callback)
    let offset = 0
    const next = (error?: Error | null) => {
      if (error || offset >= chunk.length) return callback(error)
      const piece = chunk.subarray(offset, offset + MAX_DATA)
      offset += piece.length
      timer?.refresh()
      write(piece, encoding, next)
    }
    next()
  }
  end.once("close", stop)
  const methods: SocketMethods = {
    setTimeout(ms: number, callback?: () => void) {
      stop()
      idleMs = ms
      // Node's HTTP agent reads it back, as on a socket.
      ;(end as Duplex & { timeout?: number }).timeout = ms
      if (idleMs > 0 && !end.destroyed) {
        timer = setTimeout(() => end.emit("timeout"), idleMs)
        timer.unref()
      }
      if (callback) {
        if (idleMs > 0) end.once("timeout", callback)
        else end.removeListener("timeout", callback)
      }
      return end as net.Socket
    },
    setNoDelay: () => end as net.Socket,
    setKeepAlive: () => end as net.Socket,
    ref: () => end as net.Socket,
    unref: () => end as net.Socket,
  }
  return Object.assign(end, methods) as net.Socket
}

/**
 * A new connection into the tunnel of environment `environmentId`: the
 * session gets one end (like a connection accepted on the Unix socket), the
 * caller the other. When either end closes, so does the other, as when a
 * socket's peer goes away.
 */
export function openTunnel(environmentId: number, options: { timeout?: number } = {}): net.Socket {
  const [local, remote] = duplexPair()
  local.once("close", () => remote.destroy())
  remote.once("close", () => local.destroy())
  const socket = socketLike(remote)
  // What net.createConnection does with it: the request's (or HTTP agent's) idle timeout.
  if (options.timeout) socket.setTimeout(options.timeout)
  const session = agentState().sessions.get(environmentId)
  if (session) session.attach(local)
  else process.nextTick(() => socket.destroy(new Error(AGENT_NOT_CONNECTED)))
  return socket
}

/** Keeps idle connections like Node's global agent did for the Unix socket (5 s), so requests in a row reuse a stream. */
class TunnelAgent extends http.Agent {
  constructor(private readonly environmentId: number) {
    super({ keepAlive: true, timeout: 5000, scheduling: "lifo" })
  }

  createConnection(options: { timeout?: number }): net.Socket {
    return openTunnel(this.environmentId, options)
  }
}

const globalForTunnels = globalThis as unknown as { __gantryTunnelAgents?: Map<number, http.Agent> }

/** The connection pool for an environment's tunnel (one per process: bundles share it through globalThis). */
export function tunnelAgent(environmentId: number): http.Agent {
  const agents = (globalForTunnels.__gantryTunnelAgents ??= new Map())
  let agent = agents.get(environmentId)
  if (!agent) {
    agent = new TunnelAgent(environmentId)
    agents.set(environmentId, agent)
  }
  return agent
}
