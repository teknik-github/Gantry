import "server-only"

import fs from "node:fs"
import net from "node:net"

import type { Kysely } from "kysely"

import { FrameDecoder, INITIAL_WINDOW, MAX_UPSTREAM_BODY, PROTOCOL_VERSION, ProtocolError } from "@/lib/agent/protocol"
import { parseAgentInfo, type AgentInfo, type StoredAgentInfo } from "@/lib/server/agent/info"
import { hashAgentKey, maskAgentKey, parseAgentKey, verifyAgentKey } from "@/lib/server/agent/keys"
import { AgentSession } from "@/lib/server/agent/session"
import { agentSocketPath, agentState } from "@/lib/server/agent/state"
import { audit, SYSTEM_ACTOR } from "@/lib/server/audit"
import type { Database } from "@/lib/server/db/schema"
import { checkRateLimit, clearFailures, recordFailure } from "@/lib/server/rate-limit"
import { safeEqual } from "@/lib/server/safe-equal"

/**
 * Accepting agents and carrying their traffic, independent of Next.js so it
 * can be tested with a plain HTTP server (route handlers in app/api/agent/
 * only translate requests). Each connected agent gets a Unix socket in a
 * private directory; anything that connects there (the Docker API client,
 * the docker compose CLI) is tunneled to the agent's Docker socket.
 */

function intFromEnv(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

export const agentLimits = () => ({
  /** How long a connection waits for a free stream before it gets a 503. */
  queueMs: intFromEnv("GANTRY_AGENT_QUEUE_SECONDS", 30, 1, 600) * 1000,
  /** Tunneled connections per agent at once (Docker API requests, log/event streams, consoles, compose). */
  maxStreams: intFromEnv("GANTRY_AGENT_MAX_STREAMS", 64, 4, 1024),
  heartbeatMs: intFromEnv("GANTRY_AGENT_HEARTBEAT_SECONDS", 10, 2, 120) * 1000,
  window: INITIAL_WINDOW,
})

/** Failed enrollments allowed per window, per environment named in the key and per client address. */
export const AGENT_FAILURE_WINDOW_MS = 5 * 60_000
export const AGENT_ENV_FAILURE_LIMIT = 20
export const AGENT_CLIENT_FAILURE_LIMIT = 10
const AGENT_MALFORMED_LIMIT = 100

type Hub = {
  /** By session id, for upstream POSTs. */
  bySession: Map<string, AgentSession>
  servers: Map<number, net.Server>
}

const globalForHub = globalThis as unknown as { __gantryAgentHub?: Hub }
const hub = (): Hub => (globalForHub.__gantryAgentHub ??= { bySession: new Map(), servers: new Map() })

// Every entry of the registry is an AgentSession (only register() adds them);
// it is typed as LiveAgent there so other modules don't depend on the class.
function sessionFor(environmentId: number): AgentSession | undefined {
  const live = agentState().sessions.get(environmentId) as AgentSession | undefined
  return live && !live.closed ? live : undefined
}

export type AcceptResult =
  | { ok: true; session: AgentSession }
  | { ok: false; status: number; error: string; retryAfter?: number }

/** "Bearer <key>" → key, or null. */
export function bearer(header: string | null): string | null {
  const m = /^Bearer[ ]+(\S{1,256})\s*$/i.exec(header ?? "")
  return m ? m[1] : null
}

/**
 * Authenticates an agent's GET /api/agent/connect and starts its session.
 * `clientAddress` is only set when it can be trusted (TRUST_PROXY), for the
 * per-client rate limit; `remoteAddress` is shown to admins only.
 */
export async function acceptAgent(
  db: Kysely<Database>,
  input: { authorization: string | null; info: string | null; clientAddress: string | null; remoteAddress: string | null }
): Promise<AcceptResult> {
  const key = bearer(input.authorization)
  const claimed = key ? parseAgentKey(key) : null
  const buckets = [
    claimed
      ? { key: `agent:env:${claimed.environmentId}`, limit: AGENT_ENV_FAILURE_LIMIT }
      : { key: "agent:malformed", limit: AGENT_MALFORMED_LIMIT },
    ...(input.clientAddress ? [{ key: `agent:client:${input.clientAddress}`, limit: AGENT_CLIENT_FAILURE_LIMIT }] : []),
  ]
  for (const b of buckets) {
    const wait = checkRateLimit(b.key, b.limit)
    if (wait) return { ok: false, status: 429, error: "Too many failed attempts; try again later", retryAfter: wait }
  }

  const refuse = async (why: string): Promise<AcceptResult> => {
    let first = false
    let locked = false
    for (const b of buckets) {
      const n = recordFailure(b.key, AGENT_FAILURE_WINDOW_MS)
      if (n === 1) first = true
      if (n === b.limit) locked = true
    }
    const who = key ? maskAgentKey(key) : "(no key)"
    console.warn(`[gantry] agent refused (${why}): ${who} from ${input.remoteAddress ?? "unknown address"}`)
    // Audited on the first failure and when a bucket locks, not on every retry.
    if (first || locked) {
      await audit(SYSTEM_ACTOR("agent"), "agent.refused", `${who} ${why}${locked ? " (rate limited)" : ""}`)
    }
    return { ok: false, status: 401, error: "Agent key rejected: it was rotated, or its environment was deleted" }
  }

  if (!key || !claimed) return refuse("malformed key")
  const env = await db
    .selectFrom("environments")
    .select(["id", "name", "type", "agent_key_hash"])
    .where("id", "=", claimed.environmentId)
    .executeTakeFirst()
  // Always hash and compare, also for a missing environment.
  const valid = verifyAgentKey(key, env?.type === "agent" ? env.agent_key_hash : null)
  if (!env || !valid) return refuse(env ? "wrong key" : "unknown environment")

  const info = parseAgentInfo(input.info)
  if (!info) return { ok: false, status: 400, error: "Missing or invalid X-Gantry-Agent-Info header" }
  if (info.protocol !== PROTOCOL_VERSION) {
    return {
      ok: false,
      status: 426,
      error: `This Gantry speaks agent protocol ${PROTOCOL_VERSION}, the agent ${info.protocol}: run the agent from the same Gantry image version`,
    }
  }
  clearFailures(buckets[0].key)

  const keyHash = hashAgentKey(key)
  const previous = sessionFor(env.id)
  if (previous) {
    console.warn(`[gantry] agent ${env.id} (${env.name}) connected again; replacing its previous session`)
    previous.close("replaced by a new connection with the same key")
  }

  const limits = agentLimits()
  const session: AgentSession = new AgentSession({
    environmentId: env.id,
    environmentName: env.name,
    keyHash,
    info,
    remoteAddress: input.remoteAddress,
    ...limits,
    revalidate: async () => {
      const row = await db
        .selectFrom("environments")
        .select(["type", "agent_key_hash"])
        .where("id", "=", env.id)
        .executeTakeFirst()
      if (!row || row.type !== "agent" || row.agent_key_hash !== keyHash) return false
      await db.updateTable("environments").set({ agent_seen_at: new Date().toISOString() }).where("id", "=", env.id).execute()
      return true
    },
    onClose: (reason) => onSessionClosed(db, session, reason),
  })
  await register(session)
  const stored: StoredAgentInfo = { ...info, remoteAddress: input.remoteAddress, connectedAt: session.connectedAt.toISOString() }
  await db
    .updateTable("environments")
    .set({ agent_seen_at: session.connectedAt.toISOString(), agent_info: JSON.stringify(stored) })
    .where("id", "=", env.id)
    .execute()
  console.log(
    `[gantry] agent connected: environment ${env.id} (${env.name}), host ${info.hostname}, Docker ${info.dockerVersion || "?"}, agent ${info.version}, from ${input.remoteAddress ?? "unknown address"}`
  )
  return { ok: true, session }
}

async function register(session: AgentSession) {
  const state = agentState()
  const h = hub()
  state.sessions.set(session.environmentId, session)
  h.bySession.set(session.id, session)
  if (!h.servers.has(session.environmentId)) {
    try {
      h.servers.set(session.environmentId, await listen(session.environmentId))
    } catch (err) {
      session.close(`Gantry could not open the local socket for this agent: ${(err as Error).message}`)
      throw err
    }
  }
}

/** The Unix socket (0600, in a 0700 directory) that leads into the environment's current tunnel. */
async function listen(environmentId: number): Promise<net.Server> {
  const file = agentSocketPath(environmentId)
  fs.rmSync(file, { force: true })
  const server = net.createServer({ allowHalfOpen: true }, (conn) => {
    const session = sessionFor(environmentId)
    if (session) session.attach(conn)
    else conn.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(file, () => {
      server.off("error", reject)
      resolve()
    })
  })
  fs.chmodSync(file, 0o600)
  server.unref()
  return server
}

function onSessionClosed(db: Kysely<Database>, session: AgentSession, reason: string) {
  const state = agentState()
  const h = hub()
  h.bySession.delete(session.id)
  const seconds = Math.round((Date.now() - session.connectedAt.getTime()) / 1000)
  console.log(
    `[gantry] agent disconnected: environment ${session.environmentId} after ${seconds}s (${reason}); ${session.bytesDown} bytes down, ${session.bytesUp} up`
  )
  // A replacement session keeps the socket; otherwise it goes away.
  if (state.sessions.get(session.environmentId) !== session) return
  state.sessions.delete(session.environmentId)
  const server = h.servers.get(session.environmentId)
  h.servers.delete(session.environmentId)
  server?.close()
  fs.rmSync(agentSocketPath(session.environmentId), { force: true })
  void db
    .updateTable("environments")
    .set({ agent_seen_at: new Date().toISOString() })
    .where("id", "=", session.environmentId)
    .execute()
    .catch(() => {})
}

export type UpstreamInput = {
  session: string | null
  authorization: string | null
  seq: string | null
  contentLength: string | null
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null
}

/** Handles an agent's POST /api/agent/upstream: a numbered batch of frames. */
export async function receiveUpstream(input: UpstreamInput): Promise<{ status: number; error?: string }> {
  const session = input.session ? hub().bySession.get(input.session) : undefined
  const secret = bearer(input.authorization)
  if (!session || session.closed || !secret || !safeEqual(secret, session.secret)) {
    return { status: 401, error: "Unknown or expired agent session; reconnect" }
  }
  const length = Number(input.contentLength)
  if (input.contentLength !== null && (!Number.isSafeInteger(length) || length > MAX_UPSTREAM_BODY)) {
    session.close("upstream batch too large")
    return { status: 413, error: "Upstream batch too large" }
  }
  if (input.seq !== String(session.expectedSeq)) {
    session.close(`upstream batch out of order (got ${input.seq}, expected ${session.expectedSeq})`)
    return { status: 409, error: "Upstream batch out of order; reconnect" }
  }
  session.expectedSeq++

  const decoder = new FrameDecoder()
  let total = 0
  try {
    for await (const chunk of input.body ?? []) {
      total += chunk.length
      if (total > MAX_UPSTREAM_BODY) throw new ProtocolError("upstream batch too large")
      for (const frame of decoder.push(chunk)) session.receive(frame)
    }
    if (decoder.pending) throw new ProtocolError("upstream batch ends inside a frame")
  } catch (err) {
    // By name: the session may come from another bundle's copy of the protocol module.
    const protocol = (err as Error).name === "ProtocolError"
    const message = protocol ? (err as Error).message : `upstream read failed: ${(err as Error).message}`
    session.close(`protocol error: ${message}`)
    return { status: protocol ? 400 : 502, error: message }
  }
  return { status: 204 }
}

/** Ends an environment's agent session, e.g. after its key was rotated or it was deleted. */
export function disconnectAgent(environmentId: number, reason: string) {
  sessionFor(environmentId)?.close(reason, { retry: false })
}

export type AgentStatus = {
  connected: boolean
  /** Id of the live session. */
  session: string | null
  connectedAt: string | null
  info: AgentInfo | null
  remoteAddress: string | null
  rttMs: number | null
  streams: number
  queued: number
}

/** Live state of an environment's agent (this process only). */
export function agentStatus(environmentId: number): AgentStatus {
  const s = sessionFor(environmentId)
  if (!s) return { connected: false, session: null, connectedAt: null, info: null, remoteAddress: null, rttMs: null, streams: 0, queued: 0 }
  return {
    connected: true,
    session: s.id,
    connectedAt: s.connectedAt.toISOString(),
    info: s.info,
    remoteAddress: s.remoteAddress,
    rttMs: s.rttMs,
    streams: s.streamCount,
    queued: s.queued,
  }
}
