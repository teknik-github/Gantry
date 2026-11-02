import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { SignJWT } from "jose"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { Kysely, SqliteDialect } from "kysely"

import { agentStatus } from "@/lib/server/agent/hub"
import { generateAgentKey, hashAgentKey } from "@/lib/server/agent/keys"
import { agentUrl } from "@/lib/server/agent/state"
import { dockerRequest, type DockerTarget } from "@/lib/server/docker/client"
import { tarHeader } from "@/lib/server/tar"
import { runTrivy } from "@/lib/server/trivy"
import type { Database } from "@/lib/server/db/schema"
import { openSqlite } from "@/lib/server/db/sqlite"

import { docker, dockerAvailable } from "../e2e/docker"
import { startAgentEndpoint, waitFor } from "../helpers/agent-harness"
import { openTestDb } from "../helpers/test-db"

// Throughput of the agent tunnel against the host's real Docker daemon, next
// to the local socket: 50 MiB into a container (PUT /archive) and out of it
// (GET /archive). Agents run as their own processes, like in production.
// Opt-in: GANTRY_TEST_AGENT_BENCH=1. Creates and removes the container
// gantry-test-c-bench.
//
//   GANTRY_TEST_AGENT_BENCH_ROUNDS  rounds (default 3); transfers alternate
//                                   between the local socket and each agent,
//                                   so load changes on a busy host hit all alike
//   GANTRY_TEST_AGENT_SCRIPT        agent script(s), comma-separated (default
//                                   agent/gantry-agent.mjs): e.g. 1.0.0 next to
//                                   the current one, each its own environment
//   GANTRY_TEST_AGENT_BENCH_NEXT=1  Gantry is the production build
//                                   (.next/standalone, from `pnpm build`) on
//                                   127.0.0.1:3361 with a scratch data directory,
//                                   measured through its tunnel sockets; else
//                                   its endpoints on a plain Node HTTP server
//                                   (tests/helpers), without Next.js's overhead.
//                                   Also times Gantry's own file download and
//                                   upload (/api/files/download,
//                                   /api/uploads/files) of the same 50 MiB with a
//                                   plain HTTP client, as a signed-in admin
//   GANTRY_TEST_AGENT_BENCH_STANDALONE  another standalone build directory
//                                   (with server.js) instead of .next/standalone
//   GANTRY_TEST_AGENT_BENCH_TRIVY   an image to scan with Trivy locally and
//                                   through each agent (the image goes out of
//                                   the host and back in through the tunnel);
//                                   uses the gantry-trivy-cache volume
//                                   (TRIVY_CACHE_VOLUME), never removed here

const enabled = process.env.GANTRY_TEST_AGENT_BENCH === "1" && (await dockerAvailable())
const TRIVY_IMAGE_REF = process.env.GANTRY_TEST_AGENT_BENCH_TRIVY
const ROUNDS = Number(process.env.GANTRY_TEST_AGENT_BENCH_ROUNDS ?? 3) || 3
const SIZE = 50 * 1024 * 1024
const CONTAINER = "gantry-test-c-bench"
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock"
const SCRIPTS = (process.env.GANTRY_TEST_AGENT_SCRIPT || "agent/gantry-agent.mjs").split(",").map((s) => s.trim())
const NEXT = process.env.GANTRY_TEST_AGENT_BENCH_NEXT === "1"
const NEXT_PORT = 3361
const NEXT_SECRET = "bench-secret-bench-secret-bench-secret-0123"
const STANDALONE = path.resolve(process.env.GANTRY_TEST_AGENT_BENCH_STANDALONE || ".next/standalone")

const auditDb = vi.hoisted(() => ({ current: null as Kysely<Database> | null }))
vi.mock("@/lib/server/db", () => ({
  getDb: async () => {
    if (!auditDb.current) throw new Error("no test database")
    return auditDb.current
  },
}))

function timed(target: DockerTarget, method: string, path: string, body?: Buffer): Promise<{ seconds: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now()
    let bytes = 0
    const req = dockerRequest(
      target,
      { method, path, headers: body ? { "Content-Type": "application/x-tar", "Content-Length": body.length } : {} },
      (res) => {
        res.on("data", (c: Buffer) => (bytes += c.length))
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) reject(new Error(`${method} ${path}: HTTP ${res.statusCode}`))
          else resolve({ seconds: (performance.now() - t0) / 1000, bytes })
        })
      }
    )
    req.on("error", reject)
    req.end(body)
  })
}

async function stop(proc: ChildProcess | undefined) {
  if (!proc || proc.exitCode !== null) return
  const exited = new Promise((r) => proc.once("exit", r))
  proc.kill("SIGTERM")
  await exited
}

type Agent = { label: string; script: string; id: number; key: string; proc?: ChildProcess; target?: DockerTarget }

describe.skipIf(!enabled)("agent tunnel throughput", () => {
  let t: Awaited<ReturnType<typeof openTestDb>> | undefined
  let endpoint: Awaited<ReturnType<typeof startAgentEndpoint>> | undefined
  let server: ChildProcess | undefined
  let dataDir = ""
  let containerId = ""
  /** NEXT: a signed-in admin's session cookie. */
  let session = ""
  const agents: Agent[] = []
  const log: string[] = []

  /** Adds an agent environment to `db`. */
  async function enroll(db: Kysely<Database>, script: string, n: number): Promise<Agent> {
    const r = await db
      .insertInto("environments")
      .values({ name: `gantry-test-c-bench-${n}`, type: "agent", url: "agent://pending", created_at: new Date().toISOString() })
      .executeTakeFirstOrThrow()
    const id = Number(r.insertId)
    const key = generateAgentKey(id)
    await db.updateTable("environments").set({ url: agentUrl(id), agent_key_hash: hashAgentKey(key) }).where("id", "=", id).execute()
    return { label: `agent ${script}`, script, id, key }
  }

  /** The production build on NEXT_PORT with a scratch data directory. */
  async function startNext() {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-c-bench-"))
    server = spawn(process.execPath, [path.join(STANDALONE, "server.js")], {
      env: {
        ...process.env,
        HOSTNAME: "127.0.0.1",
        PORT: String(NEXT_PORT),
        NODE_ENV: "production",
        DB_DRIVER: "sqlite",
        DATA_DIR: dataDir,
        GANTRY_SECRET: NEXT_SECRET,
        COOKIE_SECURE: "false",
        UPDATE_CHECK_INTERVAL_HOURS: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    server.stdout!.on("data", (c: Buffer) => log.push(`[gantry] ${c}`))
    server.stderr!.on("data", (c: Buffer) => log.push(`[gantry] ${c}`))
    const url = `http://127.0.0.1:${NEXT_PORT}`
    await waitFor(() => fetch(`${url}/api/health`).then((r) => r.ok, () => false), 120_000, "Gantry to start")
    return url
  }

  beforeAll(async () => {
    let url: string
    if (NEXT) {
      url = await startNext()
      const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: openSqlite(path.join(dataDir, "gantry.db")) }) })
      try {
        // Migrated by the server at startup.
        for (const [n, script] of SCRIPTS.entries()) {
          agents.push(await waitFor(() => enroll(db, script, n).catch(() => null), 60_000, "Gantry's database"))
        }
        // An admin, signed in the way Gantry signs sessions (lib/server/auth/token.ts).
        const admin = await db
          .insertInto("users")
          .values({ username: "gantry-test-c-bench", password_hash: "!", role: "admin", created_at: new Date().toISOString() })
          .executeTakeFirstOrThrow()
        const jwt = await new SignJWT({ role: "admin", ver: 0 })
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(String(admin.insertId))
          .setIssuedAt()
          .setIssuer("gantry")
          .setExpirationTime("2h")
          .sign(new TextEncoder().encode(NEXT_SECRET))
        session = `gantry_session=${jwt}`
      } finally {
        await db.destroy()
      }
      for (const a of agents) a.target = { type: "socket", url: path.join(dataDir, "agent-sockets", `${a.id}.sock`) }
    } else {
      t = await openTestDb()
      auditDb.current = t.db
      endpoint = await startAgentEndpoint(t.db)
      url = endpoint.url
      for (const [n, script] of SCRIPTS.entries()) agents.push(await enroll(t.db, script, n))
      for (const a of agents) a.target = { type: "agent", url: agentUrl(a.id) }
    }
    for (const a of agents) {
      a.proc = spawn(process.execPath, [path.resolve(a.script)], {
        env: { ...process.env, GANTRY_URL: url, GANTRY_AGENT_KEY: a.key, DOCKER_SOCKET: SOCKET, GANTRY_AGENT_HEALTH_FILE: "" },
        stdio: ["ignore", "pipe", "pipe"],
      })
      a.proc.stdout!.on("data", (c: Buffer) => log.push(c.toString()))
      a.proc.stderr!.on("data", (c: Buffer) => log.push(c.toString()))
      if (NEXT) await waitFor(() => fs.existsSync(a.target!.url), 30_000, "agent connection")
      else await waitFor(() => agentStatus(a.id).connected, 30_000, "agent connection")
    }

    await docker("DELETE", `/containers/${CONTAINER}?force=true`).catch(() => {})
    // A busy daemon may still be removing a leftover of an earlier run.
    await waitFor(() => docker("GET", `/containers/${CONTAINER}/json`).then(() => false, () => true), 60_000, "leftover removal")
    containerId = (
      await docker<{ Id: string }>("POST", `/containers/create?name=${CONTAINER}`, {
        Image: "alpine:3",
        Cmd: ["sleep", "3600"],
        HostConfig: { Init: true },
        Labels: { "gantry.e2e": "true" },
      })
    ).Id
    await docker("POST", `/containers/${containerId}/start`)
  }, 300_000)

  afterAll(async () => {
    for (const a of agents) await stop(a.proc)
    await docker("DELETE", `/containers/${CONTAINER}?force=true`).catch(() => {})
    await endpoint?.close()
    await t?.cleanup()
    await stop(server)
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
  }, 120_000)

  const targets = (): [string, DockerTarget][] => [
    ["local socket", { type: "socket", url: SOCKET }],
    ...agents.map((a): [string, DockerTarget] => [a.label, a.target!]),
  ]
  // Straight to stdout: vitest may drop console output of a file whose hooks fail.
  const out = (line: string) => process.stdout.write(`[agent bench${NEXT ? ", Next.js" : ""}] ${line}\n`)

  it("moves 50 MiB both ways", async () => {
    const data = crypto.randomBytes(SIZE)
    const header = tarHeader({ name: "big.bin", type: "file", size: SIZE, uid: 0, gid: 0, mode: 0o644 })
    const pad = (512 - (SIZE % 512)) % 512
    const tar = Buffer.concat([header, data, Buffer.alloc(pad + 1024)])
    const results = new Map<string, { up: number[]; down: number[] }>()
    for (let i = 0; i < ROUNDS; i++) {
      for (const [name, target] of targets()) {
        const r = results.get(name) ?? { up: [], down: [] }
        results.set(name, r)
        const up = await timed(target, "PUT", `/containers/${containerId}/archive?path=/tmp`, tar)
        r.up.push(SIZE / 1024 / 1024 / up.seconds)
        const down = await timed(target, "GET", `/containers/${containerId}/archive?path=/tmp/big.bin`)
        expect(down.bytes).toBeGreaterThan(SIZE)
        r.down.push(SIZE / 1024 / 1024 / down.seconds)
      }
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    const fmt = (xs: number[]) => `${median(xs).toFixed(1)} MiB/s [${xs.map((x) => x.toFixed(1)).join(", ")}]`
    for (const [name, r] of results) out(`${name}: upload ${fmt(r.up)}; download ${fmt(r.down)}`)
  }, 1_800_000)

  /** One request to Gantry's API with the admin's session in environment `envId`; seconds. */
  function api(method: string, url: string, envId: number, body?: Buffer): Promise<number> {
    return new Promise((resolve, reject) => {
      const t0 = performance.now()
      let bytes = 0
      const req = http.request(
        `http://127.0.0.1:${NEXT_PORT}${url}`,
        { method, headers: { Cookie: `${session}; gantry_env=${envId}`, ...(body ? { "Content-Length": body.length } : {}) } },
        (res) => {
          res.on("data", (c: Buffer) => (bytes += c.length))
          res.on("end", () => {
            if (res.statusCode !== 200) reject(new Error(`${method} ${url}: HTTP ${res.statusCode}`))
            else if (method === "GET" && bytes !== SIZE) reject(new Error(`${url}: ${bytes} bytes`))
            else resolve((performance.now() - t0) / 1000)
          })
        }
      )
      req.on("error", reject)
      req.end(body)
    })
  }

  // After "moves 50 MiB both ways", which left /tmp/big.bin in the container.
  it.skipIf(!NEXT)("moves 50 MiB through Gantry's file download and upload", async () => {
    const data = crypto.randomBytes(SIZE)
    const envs: [string, number][] = [["local socket", 1], ...agents.map((a): [string, number] => [a.label, a.id])]
    const results = new Map<string, { up: number[]; down: number[] }>()
    for (let i = 0; i < ROUNDS; i++) {
      for (const [name, envId] of envs) {
        const r = results.get(name) ?? { up: [], down: [] }
        results.set(name, r)
        r.down.push(SIZE / 1048576 / (await api("GET", `/api/files/download?container=${containerId}&path=/tmp/big.bin`, envId)))
        r.up.push(SIZE / 1048576 / (await api("PUT", `/api/uploads/files?container=${containerId}&path=/tmp&name=up.bin&overwrite=1`, envId, data)))
      }
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    const fmt = (xs: number[]) => `${median(xs).toFixed(1)} MiB/s [${xs.map((x) => x.toFixed(1)).join(", ")}]`
    for (const [name, r] of results) out(`files API, ${name}: download ${fmt(r.down)}; upload ${fmt(r.up)}`)
  }, 1_800_000)

  it.skipIf(!TRIVY_IMAGE_REF)("times a Trivy scan both ways", async () => {
    process.env.TRIVY_CACHE_VOLUME ||= "gantry-trivy-cache"
    const ref = TRIVY_IMAGE_REF!
    const { Id: imageId, Size: size } = await docker<{ Id: string; Size: number }>("GET", `/images/${encodeURIComponent(ref)}/json`)
    // Locally first: it brings the database in the cache volume up to date.
    for (const [name, target] of targets()) {
      const t0 = performance.now()
      const run = await runTrivy(target, imageId)
      const total = ((performance.now() - t0) / 1000).toFixed(1)
      const { pull, copy, scan } = run.timings
      const mb = (n: number) => (n / 1048576).toFixed(0)
      out(`Trivy ${ref} (${mb(size)} MB, ${mb(run.imageBytes)} MB exported), ${name}: ${total} s (pull ${pull} ms, copy ${copy} ms, scan ${scan} ms)`)
    }
  }, 1_800_000)
})
