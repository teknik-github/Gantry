import { spawn, type ChildProcess } from "node:child_process"
import crypto from "node:crypto"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { Kysely } from "kysely"

import { agentStatus } from "@/lib/server/agent/hub"
import { generateAgentKey, hashAgentKey } from "@/lib/server/agent/keys"
import { agentUrl } from "@/lib/server/agent/state"
import { dockerRequest, type DockerTarget } from "@/lib/server/docker/client"
import { tarHeader } from "@/lib/server/tar"
import type { Database } from "@/lib/server/db/schema"

import { docker, dockerAvailable } from "../e2e/docker"
import { startAgentEndpoint, waitFor } from "../helpers/agent-harness"
import { openTestDb } from "../helpers/test-db"

// Throughput of the agent tunnel against the host's real Docker daemon, next
// to the local socket: 50 MiB into a container (PUT /archive) and out of it
// (GET /archive). The agent runs as its own process, like in production;
// Gantry's endpoints run on a plain Node HTTP server (tests/helpers), so this
// leaves out Next.js's own overhead (the e2e benchmark in agent.spec.ts
// includes it). Opt-in: GANTRY_TEST_AGENT_BENCH=1 (rounds:
// GANTRY_TEST_AGENT_BENCH_ROUNDS, default 3; GANTRY_TEST_AGENT_SCRIPT runs
// another agent script). Creates and removes the container gantry-test-c-bench.

const enabled = process.env.GANTRY_TEST_AGENT_BENCH === "1" && (await dockerAvailable())
const ROUNDS = Number(process.env.GANTRY_TEST_AGENT_BENCH_ROUNDS ?? 3) || 3
const SIZE = 50 * 1024 * 1024
const CONTAINER = "gantry-test-c-bench"
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock"
/** Another agent script, e.g. an older release for comparison. */
const SCRIPT = process.env.GANTRY_TEST_AGENT_SCRIPT || "agent/gantry-agent.mjs"

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

describe.skipIf(!enabled)("agent tunnel throughput", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>
  let endpoint: Awaited<ReturnType<typeof startAgentEndpoint>>
  let agent: ChildProcess
  let id = 0
  let containerId = ""
  const agentLog: string[] = []

  beforeAll(async () => {
    t = await openTestDb()
    auditDb.current = t.db
    endpoint = await startAgentEndpoint(t.db)
    const r = await t.db
      .insertInto("environments")
      .values({ name: "gantry-test-c-bench", type: "agent", url: "agent://pending", created_at: new Date().toISOString() })
      .executeTakeFirstOrThrow()
    id = Number(r.insertId)
    const key = generateAgentKey(id)
    await t.db.updateTable("environments").set({ url: agentUrl(id), agent_key_hash: hashAgentKey(key) }).where("id", "=", id).execute()
    agent = spawn(process.execPath, [path.resolve(SCRIPT)], {
      env: { ...process.env, GANTRY_URL: endpoint.url, GANTRY_AGENT_KEY: key, DOCKER_SOCKET: SOCKET, GANTRY_AGENT_HEALTH_FILE: "" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    agent.stdout!.on("data", (c: Buffer) => agentLog.push(c.toString()))
    agent.stderr!.on("data", (c: Buffer) => agentLog.push(c.toString()))
    await waitFor(() => agentStatus(id).connected, 30_000, "agent connection")

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
  }, 120_000)

  afterAll(async () => {
    if (agent && agent.exitCode === null) {
      const exited = new Promise((r) => agent.once("exit", r))
      agent.kill("SIGTERM")
      await exited
    }
    await docker("DELETE", `/containers/${CONTAINER}?force=true`).catch(() => {})
    await endpoint?.close()
    await t?.cleanup()
  }, 120_000)

  it("moves 50 MiB both ways", async () => {
    const data = crypto.randomBytes(SIZE)
    const header = tarHeader({ name: "big.bin", type: "file", size: SIZE, uid: 0, gid: 0, mode: 0o644 })
    const pad = (512 - (SIZE % 512)) % 512
    const tar = Buffer.concat([header, data, Buffer.alloc(pad + 1024)])
    const local: DockerTarget = { type: "socket", url: SOCKET }
    const tunnel: DockerTarget = { type: "agent", url: agentUrl(id) }
    const results: Record<string, { up: number[]; down: number[] }> = { local: { up: [], down: [] }, agent: { up: [], down: [] } }
    for (let i = 0; i < ROUNDS; i++) {
      for (const [name, target] of [["local", local], ["agent", tunnel]] as const) {
        const up = await timed(target, "PUT", `/containers/${containerId}/archive?path=/tmp`, tar)
        results[name].up.push(SIZE / 1024 / 1024 / up.seconds)
        const down = await timed(target, "GET", `/containers/${containerId}/archive?path=/tmp/big.bin`)
        expect(down.bytes).toBeGreaterThan(SIZE)
        results[name].down.push(SIZE / 1024 / 1024 / down.seconds)
      }
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    for (const [name, r] of Object.entries(results)) {
      const fmt = (xs: number[]) => `${median(xs).toFixed(1)} MiB/s [${xs.map((x) => x.toFixed(1)).join(", ")}]`
      // Straight to stdout: vitest may drop console output of a file whose hooks fail.
      process.stdout.write(`[agent bench] ${name}${name === "agent" ? ` (${SCRIPT})` : ""}: upload ${fmt(r.up)}; download ${fmt(r.down)}\n`)
    }
  }, 600_000)
})
