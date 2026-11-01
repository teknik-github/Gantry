import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { NextRequest } from "next/server"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { ENV_COOKIE, SESSION_COOKIE, signSession } from "@/lib/server/auth/token"
import { dockerErrorMessage, DockerError } from "@/lib/server/docker/client"
import { FilesError } from "@/lib/server/files/service"
import { errorResponse as filesErrorResponse } from "@/lib/server/files/http"
import { errorResponse, json, upstreamStatus } from "@/lib/server/http"
import { KubeError } from "@/lib/server/kubernetes/client"
import { request, resetRequest } from "../helpers/request-context"
import { openTestDb } from "../helpers/test-db"

vi.mock("next/headers", async () => (await import("../helpers/request-context")).nextHeaders)
vi.mock("next/cache", async () => (await import("../helpers/request-context")).nextCache)
vi.mock("next/navigation", async () => (await import("../helpers/request-context")).nextNavigation)
vi.mock("@/lib/server/db", async () => (await import("../helpers/request-context")).serverDb)

const logsRoute = await import("@/app/api/containers/[id]/logs/route")
const statsRoute = await import("@/app/api/stats/route")
const containersRoute = await import("@/app/api/v1/containers/route")

// One rule for Docker/Kubernetes errors in route handlers (lib/server/http.ts),
// checked on the helper and on real handlers against a fake Docker socket.

describe("upstreamStatus", () => {
  it.each([
    [400, 400],
    [403, 403],
    [404, 404],
    [409, 409],
    [413, 413],
    [499, 499],
    // Gantry's credentials refused upstream is not the browser's session expiring.
    [401, 502],
    [500, 502],
    [502, 502],
    [503, 502],
    [504, 504],
    [304, 502],
    [200, 502],
    [0, 502],
    [NaN, 502],
  ])("%s → %s", (status, expected) => expect(upstreamStatus(status)).toBe(expected))
})

describe("errorResponse", () => {
  afterEach(() => vi.restoreAllMocks())

  it("answers Docker and Kubernetes errors with their message, never cached", async () => {
    const res = errorResponse(new DockerError("No such container: abc", 404), "x")
    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ error: "No such container: abc" })
    const kube = errorResponse(new KubeError("The Kubernetes API rejected the credentials (401 Unauthorized)", 401), "x")
    expect(kube.status).toBe(502)
    expect(await kube.json()).toEqual({ error: "The Kubernetes API rejected the credentials (401 Unauthorized)" })
    expect(errorResponse(new DockerError("Cannot reach Docker (ECONNREFUSED)", 502), "x").status).toBe(502)
    expect(errorResponse(new DockerError("Docker API request timed out", 504), "x").status).toBe(504)
    expect(errorResponse(new DockerError("server error", 500), "x").status).toBe(502)
  })

  it("logs anything else and answers a generic 500 without its message", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const err = new Error("SQLITE_BUSY: /data/gantry.db")
    const res = errorResponse(err, "stats")
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Something went wrong. Check the server logs." })
    expect(log).toHaveBeenCalledWith("[gantry] stats failed", err)
  })

  it("json() is never cached", async () => {
    const res = json(418, { error: "x" })
    expect(res.status).toBe(418)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("content-type")).toContain("application/json")
  })

  it("file routes add FilesError (status and code) and use the same rule otherwise", async () => {
    const exists = filesErrorResponse(new FilesError("a.txt already exists", 409, "exists"))
    expect(exists.status).toBe(409)
    expect(await exists.json()).toEqual({ error: "a.txt already exists", code: "exists" })
    expect((await filesErrorResponse(new FilesError("Invalid path")).json()).error).toBe("Invalid path")
    expect(filesErrorResponse(new DockerError("No such container: x", 404)).status).toBe(404)
    expect(filesErrorResponse(new DockerError("boom", 500)).status).toBe(502)
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = filesErrorResponse(new TypeError("x is undefined"))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Something went wrong. Check the server logs." })
    expect(log).toHaveBeenCalledWith("[gantry] file browser request failed", expect.any(TypeError))
  })
})

describe("dockerErrorMessage", () => {
  it.each([
    ['{"message":"No such container: abc"}', "No such container: abc"],
    ['  {"message":"conflict"}\n', "conflict"],
    ["plain text error\n", "plain text error"],
    ["<html>502 Bad Gateway</html>", "<html>502 Bad Gateway</html>"],
    ['{"error":"other shape"}', '{"error":"other shape"}'],
    ['{"message":42}', '{"message":42}'],
    ["null", "null"],
    ['"just a string"', '"just a string"'],
    ['{"message":""}', ""],
    ["", ""],
  ])("%j → %j", (body, expected) => expect(dockerErrorMessage(body)).toBe(expected))
})

describe("route handlers", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>
  let dir: string
  let server: http.Server
  // What the fake daemon answers for /containers/*: a status and a body.
  let answer: { status: number; body: string } = { status: 200, body: "[]" }
  const envs = { up: 0, down: 0, kube: 0 }
  const CONTAINER = "a".repeat(64)

  beforeAll(async () => {
    t = await openTestDb()
    request.db = t.db
    await t.addUser("root", "admin")
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-t-routes-"))
    const socket = path.join(dir, "docker.sock")
    server = http.createServer((req, res) => {
      res.writeHead(answer.status, { "Content-Type": "application/json" }).end(answer.body)
    })
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    const now = new Date().toISOString()
    const add = async (values: { name: string; type: "socket" | "kubernetes"; url: string }) =>
      Number((await t.db.insertInto("environments").values({ ...values, created_at: now }).executeTakeFirstOrThrow()).insertId)
    envs.up = await add({ name: "up", type: "socket", url: socket })
    envs.down = await add({ name: "down", type: "socket", url: path.join(dir, "missing.sock") })
    envs.kube = await add({ name: "kube", type: "kubernetes", url: "https://10.0.0.5:6443" })
  })

  afterAll(async () => {
    request.db = null
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    await t?.cleanup()
  })

  async function use(environmentId: number) {
    resetRequest()
    request.cookies.set(SESSION_COOKIE, await signSession({ uid: 1, role: "admin", ver: 0 }))
    request.cookies.set(ENV_COOKIE, String(environmentId))
  }

  const logs = (id = CONTAINER) =>
    logsRoute.GET(new NextRequest(`http://gantry.test/api/containers/${id}/logs`), { params: Promise.resolve({ id }) })

  beforeEach(() => {
    answer = { status: 200, body: "[]" }
  })

  it("container logs: Docker's 404 and 409 pass through, its 500 becomes 502", async () => {
    await use(envs.up)
    answer = { status: 404, body: JSON.stringify({ message: `No such container: ${CONTAINER}` }) }
    let res = await logs()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: `No such container: ${CONTAINER}` })
    answer = { status: 409, body: JSON.stringify({ message: "container is restarting" }) }
    expect((await logs()).status).toBe(409)
    answer = { status: 500, body: JSON.stringify({ message: "driver failed" }) }
    res = await logs()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: "driver failed" })
    expect((await logs("not-an-id")).status).toBe(400)
  })

  it("container logs: an unreachable daemon is a 502", async () => {
    await use(envs.down)
    const res = await logs()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: "Cannot reach Docker (ENOENT)" })
  })

  it("stats: unreachable is 502, a Kubernetes environment is 409 (was 502)", async () => {
    await use(envs.down)
    expect((await statsRoute.GET()).status).toBe(502)
    await use(envs.kube)
    const res = await statsRoute.GET()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/Kubernetes/)
  })

  it("v1 containers: lists, and maps Docker failures by the same rule", async () => {
    await use(envs.up)
    let res = await containersRoute.GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ environment: { id: envs.up, name: "up" }, containers: [] })
    answer = { status: 500, body: "boom" }
    res = await containersRoute.GET()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: "boom" })
    await use(envs.down)
    expect((await containersRoute.GET()).status).toBe(502)
    await use(envs.kube)
    expect((await containersRoute.GET()).status).toBe(409)
  })

  it("refuses without a session", async () => {
    resetRequest()
    expect((await logs()).status).toBe(401)
    expect((await statsRoute.GET()).status).toBe(401)
  })
})
