import crypto from "node:crypto"
import http from "node:http"
import type { Duplex } from "node:stream"

import type { Kysely } from "kysely"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import * as agentScript from "@/agent/gantry-agent.mjs"
import { encodeFrame, FrameType, MAX_UPSTREAM_BODY } from "@/lib/agent/protocol"
import { acceptAgent, agentStatus, disconnectAgent, receiveUpstream, AGENT_ENV_FAILURE_LIMIT } from "@/lib/server/agent/hub"
import { encodeAgentInfo } from "@/lib/server/agent/info"
import { generateAgentKey, hashAgentKey, maskAgentKey, parseAgentKey, safeEqual, verifyAgentKey } from "@/lib/server/agent/keys"
import { agentContainerIds, agentUrl } from "@/lib/server/agent/state"
import { dockerJson, dockerRaw, dockerRequest, DockerError, type DockerTarget } from "@/lib/server/docker/client"
import { dockerHost } from "@/lib/server/stacks/compose"
import { clearFailures } from "@/lib/server/rate-limit"
import { startAgentEndpoint, startFakeDocker, waitFor } from "../helpers/agent-harness"
import { openTestDb } from "../helpers/test-db"
import type { Database } from "@/lib/server/db/schema"

// Refused enrollments are audited through getDb(). Without this, that is the
// shared .test-data/unit/gantry.db, which other test files (other processes)
// open and migrate at the same time: the first audit then waits for its
// migrations and SQLite's 5 s busy timeout, which made "refuses wrong keys"
// take from 2 s up to more than the 30 s test timeout on a loaded host.
// Each describe points it at its own throwaway database instead.
const auditDb = vi.hoisted(() => ({ current: null as Kysely<Database> | null }))
vi.mock("@/lib/server/db", () => ({
  getDb: async () => {
    if (!auditDb.current) throw new Error("no test database")
    return auditDb.current
  },
}))

describe("agent keys", () => {
  it("embeds the environment id and 256 random bits", () => {
    const key = generateAgentKey(12)
    expect(key).toMatch(/^gak_12_[A-Za-z0-9_-]{43}$/)
    expect(parseAgentKey(key)).toEqual({ environmentId: 12 })
    expect(generateAgentKey(12)).not.toBe(key)
    for (const bad of ["", "gak_0_" + "A".repeat(43), "gak_12_short", "gtk_" + "A".repeat(43), `${key}x`, `gak_012_${"A".repeat(43)}`]) {
      expect(parseAgentKey(bad)).toBeNull()
    }
    expect(() => generateAgentKey(0)).toThrow()
  })

  it("verifies against the stored SHA-256 hash only", () => {
    const key = generateAgentKey(5)
    const hash = hashAgentKey(key)
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
    expect(hash).toBe(crypto.createHash("sha256").update(key).digest("hex"))
    expect(verifyAgentKey(key, hash)).toBe(true)
    expect(verifyAgentKey(generateAgentKey(5), hash)).toBe(false)
    expect(verifyAgentKey(key, null)).toBe(false)
    expect(verifyAgentKey(key, "not-a-hash")).toBe(false)
    expect(verifyAgentKey(key, hash.toUpperCase())).toBe(false)
  })

  it("never shows more than a prefix of the secret", () => {
    const key = generateAgentKey(9)
    expect(maskAgentKey(key)).toBe(`gak_9_${key.slice(6, 10)}…`)
    expect(maskAgentKey("garbage")).toBe("(malformed key)")
  })

  it("compares session secrets in constant time", () => {
    expect(safeEqual("abc", "abc")).toBe(true)
    expect(safeEqual("abc", "abd")).toBe(false)
    expect(safeEqual("abc", "abcd")).toBe(false)
  })
})

const INFO = encodeAgentInfo({ version: "test", protocol: 1, hostname: "h", dockerVersion: "1", os: "", arch: "" })

describe("agent enrollment", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>

  beforeAll(async () => {
    t = await openTestDb()
    auditDb.current = t.db
  })
  afterAll(() => t?.cleanup())

  async function addAgentEnvironment(name: string) {
    const r = await t.db
      .insertInto("environments")
      .values({ name, type: "agent", url: "agent://pending", created_at: new Date().toISOString() })
      .executeTakeFirstOrThrow()
    const id = Number(r.insertId)
    const key = generateAgentKey(id)
    await t.db.updateTable("environments").set({ url: agentUrl(id), agent_key_hash: hashAgentKey(key) }).where("id", "=", id).execute()
    return { id, key }
  }

  const connect = (authorization: string | null, info: string | null = INFO, clientAddress: string | null = null) =>
    acceptAgent(t.db, { authorization, info, clientAddress, remoteAddress: "192.0.2.1" })

  it("accepts the current key and records the agent's info", async () => {
    const { id, key } = await addAgentEnvironment("gantry-test-a-accept")
    const res = await connect(`Bearer ${key}`)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(agentStatus(id)).toMatchObject({ connected: true, remoteAddress: "192.0.2.1", info: { hostname: "h", version: "test" } })
    const row = await t.db.selectFrom("environments").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
    expect(JSON.parse(row.agent_info!)).toMatchObject({ hostname: "h", remoteAddress: "192.0.2.1" })
    expect(row.agent_seen_at).toBeTruthy()
    // Nothing about the key but its hash is stored.
    expect(JSON.stringify(row)).not.toContain(key.slice(8))

    // The downstream starts with HELLO carrying the session credentials.
    const reader = res.session.downstream.getReader()
    const { value } = await reader.read()
    const hello = JSON.parse(Buffer.from(value!).subarray(9).toString())
    expect(hello).toMatchObject({ protocol: 1, session: res.session.id, environment: { id, name: "gantry-test-a-accept" } })
    reader.releaseLock()

    disconnectAgent(id, "test over")
    expect(agentStatus(id).connected).toBe(false)
  })

  it("refuses wrong keys, keys of other environments and deleted environments", async () => {
    const a = await addAgentEnvironment("gantry-test-a-a")
    const b = await addAgentEnvironment("gantry-test-a-b")
    for (const auth of [
      null,
      "Bearer nope",
      `Basic ${a.key}`,
      `Bearer ${generateAgentKey(a.id)}`,
      // b's key with a's id swapped in: the hash doesn't match a's.
      `Bearer ${b.key.replace(`gak_${b.id}_`, `gak_${a.id}_`)}`,
      `Bearer ${generateAgentKey(999_999)}`,
    ]) {
      const res = await connect(auth)
      expect(res, String(auth)).toMatchObject({ ok: false, status: 401 })
    }
    // Audited on the first failure of each bucket, not on every retry.
    const audited = await t.db.selectFrom("audit_logs").select("target").where("action", "=", "agent.refused").execute()
    expect(audited.length).toBeGreaterThan(0)
    expect(audited.length).toBeLessThan(6)
    await t.db.deleteFrom("environments").where("id", "=", b.id).execute()
    expect(await connect(`Bearer ${b.key}`)).toMatchObject({ ok: false, status: 401 })
    // A non-agent environment never accepts agents, even with a hash set.
    await t.db.updateTable("environments").set({ type: "tcp" }).where("id", "=", a.id).execute()
    expect(await connect(`Bearer ${a.key}`)).toMatchObject({ ok: false, status: 401 })
    clearFailures(`agent:env:${a.id}`)
    clearFailures("agent:malformed")
  })

  it("rejects a missing info header and other protocol versions", async () => {
    const { id, key } = await addAgentEnvironment("gantry-test-a-proto")
    expect(await connect(`Bearer ${key}`, null)).toMatchObject({ ok: false, status: 400 })
    expect(await connect(`Bearer ${key}`, encodeAgentInfo({ protocol: 2 }))).toMatchObject({ ok: false, status: 426 })
    expect(agentStatus(id).connected).toBe(false)
  })

  it("rate-limits failed enrollments per environment and per client", async () => {
    const { id, key } = await addAgentEnvironment("gantry-test-a-rate")
    for (let i = 0; i < AGENT_ENV_FAILURE_LIMIT; i++) {
      expect(await connect(`Bearer ${generateAgentKey(id)}`)).toMatchObject({ status: 401 })
    }
    const limited = await connect(`Bearer ${generateAgentKey(id)}`)
    expect(limited).toMatchObject({ ok: false, status: 429 })
    expect(limited.ok ? 0 : limited.retryAfter).toBeGreaterThan(0)
    // Locked for this environment until the window passes, whatever the key.
    expect(await connect(`Bearer ${key}`)).toMatchObject({ status: 429 })
    clearFailures(`agent:env:${id}`)
    const ok = await connect(`Bearer ${key}`)
    expect(ok.ok).toBe(true)
    disconnectAgent(id, "test over")

    // A trusted client address has its own, smaller bucket.
    for (let i = 0; i < 10; i++) await connect("Bearer junk", INFO, "198.51.100.7")
    expect(await connect("Bearer junk", INFO, "198.51.100.7")).toMatchObject({ status: 429 })
    expect(await connect("Bearer junk", INFO, "198.51.100.8")).toMatchObject({ status: 401 })
    clearFailures("agent:client:198.51.100.7")
    clearFailures("agent:client:198.51.100.8")
    clearFailures("agent:malformed")
  })

  it("drops an agent that stops answering heartbeats", async () => {
    process.env.GANTRY_AGENT_HEARTBEAT_SECONDS = "2"
    try {
      const { id, key } = await addAgentEnvironment("gantry-test-a-silent")
      const res = await connect(`Bearer ${key}`)
      if (!res.ok) throw new Error("not accepted")
      // Nothing comes back upstream (no PONG): gone after 3.5 intervals.
      await waitFor(() => res.session.closed, 12_000, "heartbeat timeout")
      expect(res.session.closeReason).toMatch(/heartbeat timeout/)
      expect(agentStatus(id).connected).toBe(false)
    } finally {
      delete process.env.GANTRY_AGENT_HEARTBEAT_SECONDS
    }
  }, 20_000)

  it("checks upstream session, secret, order and size", async () => {
    const { id, key } = await addAgentEnvironment("gantry-test-a-up")
    const res = await connect(`Bearer ${key}`)
    if (!res.ok) throw new Error("not accepted")
    const s = res.session
    const pong = encodeFrame(FrameType.PONG, 0, Buffer.alloc(8))
    const up = (over: Partial<Parameters<typeof receiveUpstream>[0]>) =>
      receiveUpstream({
        session: s.id,
        authorization: `Bearer ${s.secret}`,
        seq: "0",
        contentLength: String(pong.length),
        body: [pong],
        ...over,
      })
    expect(await up({ session: "nope" })).toMatchObject({ status: 401 })
    expect(await up({ authorization: `Bearer ${s.secret.slice(1)}x` })).toMatchObject({ status: 401 })
    expect(await up({})).toEqual({ status: 204 })
    expect(await up({ seq: "1" })).toEqual({ status: 204 })
    // Replayed or skipped batches end the session.
    expect(await up({ seq: "1" })).toMatchObject({ status: 409 })
    expect(s.closed).toBe(true)
    expect(agentStatus(id).connected).toBe(false)

    const again = await connect(`Bearer ${key}`)
    if (!again.ok) throw new Error("not accepted")
    const big = await receiveUpstream({
      session: again.session.id,
      authorization: `Bearer ${again.session.secret}`,
      seq: "0",
      contentLength: String(MAX_UPSTREAM_BODY + 1),
      body: [],
    })
    expect(big).toMatchObject({ status: 413 })

    const third = await connect(`Bearer ${key}`)
    if (!third.ok) throw new Error("not accepted")
    const header = Buffer.alloc(9)
    header.writeUInt8(FrameType.DATA, 0)
    header.writeUInt32BE(1, 1)
    header.writeUInt32BE(10 * 1024 * 1024, 5)
    const bad = await receiveUpstream({
      session: third.session.id,
      authorization: `Bearer ${third.session.secret}`,
      seq: "0",
      contentLength: null,
      body: [header],
    })
    expect(bad).toMatchObject({ status: 400, error: expect.stringMatching(/too large/) })
    expect(third.session.closed).toBe(true)
  })
})

describe("tunnel through a real agent", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>
  let endpoint: Awaited<ReturnType<typeof startAgentEndpoint>>
  let fake: Awaited<ReturnType<typeof startFakeDocker>>
  let id = 0
  let key = ""
  let target: DockerTarget
  let abort: AbortController
  let running: Promise<void>
  let sessions: agentScript.Session[] = []
  const logs: string[] = []

  async function startAgent() {
    abort = new AbortController()
    sessions = []
    const config = agentScript.loadConfig({ GANTRY_URL: endpoint.url, GANTRY_AGENT_KEY: key, DOCKER_SOCKET: fake.socket })
    running = agentScript.runAgent(config, { signal: abort.signal, onSession: (s: agentScript.Session) => sessions.push(s) })
    // Connected on both ends: Gantry's live session is the one the agent got HELLO for.
    await waitFor(() => {
      const hello = sessions.at(-1)?.hello
      return hello && agentStatus(id).session === hello.session
    }, 10_000, "agent connection")
  }

  async function stopAgent() {
    abort.abort()
    await running
    await waitFor(() => !agentStatus(id).connected, 5000, "disconnect")
  }

  beforeAll(async () => {
    agentScript.setLogger((level: string, message: string) => logs.push(`${level} ${message}`))
    t = await openTestDb()
    auditDb.current = t.db
    endpoint = await startAgentEndpoint(t.db)
    fake = await startFakeDocker()
    const r = await t.db
      .insertInto("environments")
      .values({ name: "gantry-test-a-tunnel", type: "agent", url: "agent://pending", created_at: new Date().toISOString() })
      .executeTakeFirstOrThrow()
    id = Number(r.insertId)
    key = generateAgentKey(id)
    await t.db.updateTable("environments").set({ url: agentUrl(id), agent_key_hash: hashAgentKey(key) }).where("id", "=", id).execute()
    target = { type: "agent", url: agentUrl(id) }
    await startAgent()
  })

  afterEach(() => {
    delete process.env.GANTRY_AGENT_MAX_STREAMS
    delete process.env.GANTRY_AGENT_QUEUE_SECONDS
  })

  afterAll(async () => {
    abort?.abort()
    await running
    await endpoint?.close()
    await fake?.close()
    await t?.cleanup()
  })

  it("reports the host the agent runs on", () => {
    expect(agentStatus(id)).toMatchObject({ connected: true, info: { hostname: "fake-host", dockerVersion: "99.0.0-fake", os: "FakeOS" } })
    expect(logs.some((l) => l.includes('connected to') && l.includes("gantry-test-a-tunnel"))).toBe(true)
    // Outside a container there is nothing to protect.
    expect(agentContainerIds()).toEqual([])
  })

  it("carries Docker API calls, and compose gets the same socket", async () => {
    expect(await dockerJson(target, "GET", "/containers/json")).toEqual([{ Id: "a".repeat(64), Names: ["/gantry-test-a-fake"] }])
    expect(dockerHost(target)).toMatch(new RegExp(`^unix://.*/${id}\\.sock$`))
    const many = await Promise.all(Array.from({ length: 30 }, () => dockerJson<{ Version: string }>(target, "GET", "/version")))
    expect(many.every((v) => v.Version === "99.0.0-fake")).toBe(true)
  })

  it("streams large bodies both ways intact", async () => {
    const size = 20 * 1024 * 1024
    const { body } = await dockerRaw(target, "GET", "/blob", { query: { size } })
    expect(body.length).toBe(size)
    const expected = crypto.createHash("sha256").update(body).digest("hex")
    const check = await new Promise<string>((resolve, reject) => {
      dockerRequest(target, { method: "GET", path: `/blob?size=${size}` }, (res) => {
        res.resume()
        resolve(String(res.headers["x-sha256"]))
      }).on("error", reject).end()
    })
    expect(check).toBe(expected)

    const sink = await dockerJson<{ sha256: string; length: number }>(target, "POST", "/sink", {
      rawBody: { data: body, contentType: "application/octet-stream" },
    })
    expect(sink).toEqual({ sha256: expected, length: size })
  })

  it("pauses the agent's reads when Gantry's side doesn't consume (flow control)", async () => {
    const size = 30 * 1024 * 1024
    let res!: http.IncomingMessage
    await new Promise<void>((resolve, reject) => {
      dockerRequest(target, { method: "GET", path: `/blob?size=${size}` }, (r) => {
        res = r
        r.pause()
        resolve()
      }).on("error", reject).end()
    })
    await new Promise((r) => setTimeout(r, 500))
    const stream = [...sessions.at(-1)!.streams.values()].find((s) => s.sendWindow <= 0)
    // The agent stopped at its window instead of pushing all 30 MB.
    expect(stream).toBeTruthy()
    expect(stream.sock.isPaused()).toBe(true)
    let received = 0
    res.on("data", (c: Buffer) => (received += c.length))
    res.resume()
    await new Promise((r) => res.on("end", r))
    expect(received).toBe(size)
  })

  it("carries hijacked (exec) connections in both directions", async () => {
    const socket = await new Promise<Duplex>((resolve, reject) => {
      const req = dockerRequest(target, {
        method: "POST",
        path: "/echo",
        headers: { Connection: "Upgrade", Upgrade: "tcp", "Content-Type": "application/json" },
      })
      req.on("upgrade", (_res, s, head) => {
        if (head.length) s.unshift(head)
        resolve(s)
      })
      req.on("error", reject)
      req.end()
    })
    const echoed = await new Promise<string>((resolve) => {
      let got = ""
      socket.on("data", (c: Buffer) => {
        got += c.toString()
        if (got.includes("ping-42")) resolve(got)
      })
      socket.write("ping-42")
    })
    expect(echoed).toBe("ping-42")
    socket.destroy()
  })

  it("limits concurrent tunneled connections: extra ones wait, then get a 503", async () => {
    await stopAgent()
    process.env.GANTRY_AGENT_MAX_STREAMS = "4"
    process.env.GANTRY_AGENT_QUEUE_SECONDS = "2"
    await startAgent()
    const held: http.ClientRequest[] = []
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve, reject) => {
        const req = dockerRequest(target, { method: "GET", path: "/hold", agent: false }, () => resolve())
        req.on("error", reject).end()
        held.push(req)
      })
    }
    await waitFor(() => fake.held.size === 4, 5000, "held streams")
    expect(sessions.at(-1)!.streams.size).toBe(4)

    // Fresh connections (no keep-alive pool) so each request needs its own stream.
    const fresh = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        dockerRequest(target, { method: "GET", path, agent: false }, (res) => {
          const chunks: Buffer[] = []
          res.on("data", (c: Buffer) => chunks.push(c))
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
        })
          .on("error", reject)
          .end()
      })

    // A fifth waits for a free stream and goes through once one closes...
    const waiting = fresh("/version")
    await waitFor(() => agentStatus(id).queued === 1, 5000, "queued connection")
    held.pop()!.destroy()
    expect(await waiting).toMatchObject({ status: 200, body: expect.stringContaining("99.0.0-fake") })

    // ...or, when none frees up in time, gets an answer that says why.
    await new Promise<void>((resolve, reject) => {
      const req = dockerRequest(target, { method: "GET", path: "/hold", agent: false }, () => resolve())
      req.on("error", reject).end()
      held.push(req)
    })
    expect(sessions.at(-1)!.streams.size).toBe(4)
    const refused = await fresh("/version")
    expect(refused.status).toBe(503)
    expect(JSON.parse(refused.body).message).toMatch(/Too many connections through the agent at once \(limit 4/)

    for (const r of held) r.destroy()
    await waitFor(() => agentStatus(id).streams === 0, 5000, "streams to close")
    expect((await dockerJson<{ Version: string }>(target, "GET", "/version")).Version).toBe("99.0.0-fake")
  })

  it("fails fast with a clear error while the agent is offline", async () => {
    await stopAgent()
    const err = (await dockerJson(target, "GET", "/version").catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(DockerError)
    expect(err.message).toMatch(/agent of this environment is not connected/)
    await startAgent()
  })

  it("disconnects the agent when its key is rotated, and refuses the old key", async () => {
    const newKey = generateAgentKey(id)
    await t.db.updateTable("environments").set({ agent_key_hash: hashAgentKey(newKey) }).where("id", "=", id).execute()
    disconnectAgent(id, "the key was rotated")
    await waitFor(() => logs.some((l) => l.includes("reconnecting in 300s")), 10_000, "slow retry")
    expect(agentStatus(id).connected).toBe(false)
    // The agent was told why, and that retrying soon is pointless.
    expect(logs.some((l) => l.includes("Gantry ended the session: the key was rotated"))).toBe(true)
    // When it does try again, the old key is refused.
    const res = await fetch(`${endpoint.url}/api/agent/connect`, {
      headers: { Authorization: `Bearer ${key}`, "X-Gantry-Agent-Info": INFO },
    })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/rotated/)
    clearFailures(`agent:env:${id}`)
  })
})
