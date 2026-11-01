import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { i18nFor } from "@/lib/i18n"
import { hashAgentKey, parseAgentKey } from "@/lib/server/agent/keys"
import { ENV_COOKIE, SESSION_COOKIE, signSession } from "@/lib/server/auth/token"
import { decryptTls } from "@/lib/server/environment-target"
import { KubeError } from "@/lib/server/kubernetes/client"
import { request, resetRequest } from "../helpers/request-context"
import { openTestDb } from "../helpers/test-db"

vi.mock("next/headers", async () => (await import("../helpers/request-context")).nextHeaders)
vi.mock("next/cache", async () => (await import("../helpers/request-context")).nextCache)
vi.mock("next/navigation", async () => (await import("../helpers/request-context")).nextNavigation)
vi.mock("@/lib/server/db", async () => (await import("../helpers/request-context")).serverDb)

// The cluster check of Kubernetes environments; no real cluster is used.
const kubeFake = vi.hoisted(() => ({ version: null as null | (() => Promise<{ gitVersion: string }>), checkAccess: null as null | (() => Promise<void>) }))
vi.mock("@/lib/server/kubernetes/api", () => ({
  kube: () => ({ version: () => kubeFake.version!(), checkAccess: () => kubeFake.checkAccess!() }),
}))
vi.mock("@/lib/server/docker/exec", async (original) => ({
  ...(await original<typeof import("@/lib/server/docker/exec")>()),
  closeUserExecSessions: vi.fn(),
}))
vi.mock("@/lib/server/agent/hub", async (original) => ({
  ...(await original<typeof import("@/lib/server/agent/hub")>()),
  disconnectAgent: vi.fn(),
}))

const { createEnvironment, deleteEnvironment, selectEnvironment, setEnvironmentAccess, updateEnvironment } = await import(
  "@/app/(app)/environments/actions"
)
const { agentConnection, createAgentEnvironment, rotateAgentKey } = await import("@/app/(app)/environments/agent-actions")
const { closeUserExecSessions } = await import("@/lib/server/docker/exec")
const { disconnectAgent } = await import("@/lib/server/agent/hub")

// The Environments page's Server Actions (app/(app)/environments/): only
// administrators may change environments or who may use them; forms are
// validated; Docker endpoints are pinged before they are saved. Runs against
// a throwaway database and a tiny fake Docker socket.

const m = i18nFor("en").t.environments.messages
const common = i18nFor("en").t.common
const fmt = i18nFor("en").format

let t: Awaited<ReturnType<typeof openTestDb>>
let dir: string
let socket: string
let server: http.Server
const ids = { admin: 0, alice: 0, bob: 0, admin2: 0 }

function form(values: Record<string, string | string[]>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(values)) for (const one of [v].flat()) f.append(k, one)
  return f
}

async function signIn(uid: number, role: "admin" | "user") {
  request.cookies.set(SESSION_COOKIE, await signSession({ uid, role, ver: 0 }))
}

async function environments() {
  return t.db.selectFrom("environments").selectAll().orderBy("id").execute()
}

async function envByName(name: string) {
  return t.db.selectFrom("environments").selectAll().where("name", "=", name).executeTakeFirstOrThrow()
}

async function grantsOf(environmentId: number) {
  return t.db
    .selectFrom("environment_access")
    .select(["user_id", "role"])
    .where("environment_id", "=", environmentId)
    .orderBy("user_id")
    .execute()
}

async function lastAudit() {
  return t.db.selectFrom("audit_logs").select(["username", "action", "target"]).orderBy("id", "desc").executeTakeFirst()
}

beforeAll(async () => {
  t = await openTestDb()
  request.db = t.db
  ids.admin = await t.addUser("root", "admin")
  ids.admin2 = await t.addUser("root2", "admin")
  ids.alice = await t.addUser("alice")
  ids.bob = await t.addUser("bob")

  // Answers Docker's /_ping like a daemon would.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-t-docker-"))
  socket = path.join(dir, "docker.sock")
  server = http.createServer((req, res) => {
    if (req.url === "/_ping") return res.end("OK")
    res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "page not found" }))
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
})

afterAll(async () => {
  request.db = null
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  await t?.cleanup()
})

beforeEach(async () => {
  resetRequest()
  vi.mocked(closeUserExecSessions).mockClear()
  vi.mocked(disconnectAgent).mockClear()
  kubeFake.version = async () => ({ gitVersion: "v1.31.0" })
  kubeFake.checkAccess = async () => {}
  await signIn(ids.admin, "admin")
})

afterEach(() => vi.restoreAllMocks())

describe("createEnvironment", () => {
  it("adds a reachable Docker socket, without grants, and audits it", async () => {
    const res = await createEnvironment({}, form({ name: "  dev  ", type: "socket", url: socket }))
    expect(res).toEqual({ ok: true, message: fmt(m.added, { name: "dev" }) })
    const env = await envByName("dev")
    expect(env).toMatchObject({ type: "socket", url: socket, tls_key: null })
    expect(await grantsOf(env.id)).toEqual([])
    expect(await lastAudit()).toEqual({ username: "root", action: "environment.create", target: "dev" })
  })

  it("refuses endpoints it cannot reach and saves nothing", async () => {
    const before = await environments()
    const res = await createEnvironment({}, form({ name: "gone", type: "socket", url: path.join(dir, "missing.sock") }))
    expect(res.error).toMatch(/^Could not connect: Cannot reach Docker \(ENOENT\)$/)
    expect(await environments()).toEqual(before)
  })

  it("is for administrators only, before anything is contacted or saved", async () => {
    await signIn(ids.alice, "user")
    const before = await environments()
    expect(await createEnvironment({}, form({ name: "mine", type: "socket", url: socket }))).toEqual({ error: common.errors.adminsOnly })
    expect(await createEnvironment({}, form({ name: "k", type: "kubernetes", kube_server: "https://10.0.0.5:6443", kube_token: "tok" }))).toEqual({
      error: common.errors.adminsOnly,
    })
    expect(await environments()).toEqual(before)
    resetRequest()
    expect(await createEnvironment({}, form({ name: "mine", type: "socket", url: socket }))).toEqual({ error: common.errors.sessionExpired })
  })

  it("validates the form", async () => {
    const errors = async (values: Record<string, string>) => (await createEnvironment({}, form(values))).fieldErrors
    expect(await errors({ name: " ", type: "socket", url: socket })).toEqual({ name: [m.nameRequired] })
    expect(await errors({ name: "x", type: "socket", url: "" })).toEqual({ url: [m.addressRequired] })
    expect(await errors({ name: "x", type: "socket", url: "var/run/docker.sock" })).toEqual({ url: [m.socketPath] })
    expect(await errors({ name: "x", type: "tcp", url: "10.0.0.5" })).toEqual({ url: [m.hostPort] })
    expect(await errors({ name: "x", type: "tcp", url: "10.0.0.5", tls: "on" })).toEqual({ url: [m.hostPortTls] })
    expect(await errors({ name: "x", type: "tcp", url: "10.0.0.5; rm -rf /" })).toEqual({ url: [m.hostPort] })
    expect(await errors({ name: "x".repeat(101), type: "socket", url: socket })).toHaveProperty("name")
    expect((await createEnvironment({}, form({ name: "x", type: "ssh", url: socket }))).fieldErrors).toHaveProperty("type")
    // TLS needs parseable PEM material; the key is never echoed back.
    const tls = await createEnvironment({}, form({ name: "x", type: "tcp", url: "10.0.0.5:2376", tls: "on", tls_key: "SECRET-KEY" }))
    expect(tls.error).toBe(m.fixTls)
    expect(Object.keys(tls.fieldErrors ?? {}).length).toBeGreaterThan(0)
    expect(JSON.stringify(tls)).not.toContain("SECRET-KEY")
  })

  it("sends agent environments to their own form", async () => {
    expect(await createEnvironment({}, form({ name: "a", type: "agent" }))).toEqual({ error: m.useAddAgent })
  })

  it("adds a Kubernetes cluster that answers, with encrypted credentials", async () => {
    const res = await createEnvironment(
      {},
      form({ name: "k8s", type: "kubernetes", kube_server: "https://10.0.0.5:6443", kube_token: "sa-token-123", kube_namespace: "apps" })
    )
    expect(res).toEqual({ ok: true, message: fmt(m.added, { name: "k8s" }) })
    const env = await envByName("k8s")
    expect(env).toMatchObject({ type: "kubernetes", url: "https://10.0.0.5:6443", kube_namespace: "apps", kube_insecure: 0 })
    expect(env.kube_credentials).toBeTruthy()
    expect(env.kube_credentials).not.toContain("sa-token-123")
    expect(await lastAudit()).toMatchObject({ action: "environment.create", target: "k8s (kubernetes, token)" })
  })

  it("refuses a cluster that rejects the credentials", async () => {
    kubeFake.checkAccess = async () => Promise.reject(new KubeError("The Kubernetes API rejected the credentials (401 Unauthorized)", 401))
    const res = await createEnvironment({}, form({ name: "k8s-bad", type: "kubernetes", kube_server: "https://10.0.0.5:6443", kube_token: "x" }))
    expect(res).toEqual({ error: fmt(m.couldNotConnect, { error: "The Kubernetes API rejected the credentials (401 Unauthorized)" }) })
    expect((await environments()).some((e) => e.name === "k8s-bad")).toBe(false)
  })

  it("validates the Kubernetes connection", async () => {
    const res = await createEnvironment({}, form({ name: "k", type: "kubernetes", kube_server: "http://10.0.0.5:6443", kube_token: "" }))
    expect(res.error).toBe(common.errors.fixFields)
    expect(Object.keys(res.fieldErrors ?? {}).sort()).toEqual(["kube_server", "kube_token"])
  })
})

describe("updateEnvironment", () => {
  it("renames and repoints a Docker environment after pinging it", async () => {
    await createEnvironment({}, form({ name: "edit-me", type: "socket", url: socket }))
    const env = await envByName("edit-me")
    const res = await updateEnvironment({}, form({ id: String(env.id), name: "edited", type: "socket", url: socket }))
    expect(res).toEqual({ ok: true, message: fmt(m.saved, { name: "edited" }) })
    expect((await envByName("edited")).id).toBe(env.id)
    expect(await lastAudit()).toEqual({ username: "root", action: "environment.update", target: `${env.id}:edited` })

    const unreachable = await updateEnvironment({}, form({ id: String(env.id), name: "edited", type: "socket", url: path.join(dir, "nope.sock") }))
    expect(unreachable.error).toMatch(/^Could not connect/)
    expect((await envByName("edited")).url).toBe(socket)
  })

  it("refuses bad ids, unknown environments and type changes", async () => {
    expect(await updateEnvironment({}, form({ id: "abc", name: "x", type: "socket", url: socket }))).toEqual({ error: m.invalid })
    expect(await updateEnvironment({}, form({ id: "0", name: "x", type: "socket", url: socket }))).toEqual({ error: m.invalid })
    expect(await updateEnvironment({}, form({ id: "999", name: "x", type: "socket", url: socket }))).toEqual({ error: m.notFound })
    const k8s = await envByName("k8s")
    expect(await updateEnvironment({}, form({ id: String(k8s.id), name: "x", type: "socket", url: socket }))).toEqual({ error: m.kubernetesToDocker })
    const local = await envByName("dev")
    expect(await updateEnvironment({}, form({ id: String(local.id), name: "x", type: "kubernetes" }))).toEqual({ error: m.dockerToKubernetes })
    expect(await updateEnvironment({}, form({ id: String(local.id), name: "x", type: "agent" }))).toEqual({ error: m.onlyAgent })
    expect((await envByName("dev")).name).toBe("dev")
  })

  it("keeps TLS only when certificates are stored", async () => {
    const local = await envByName("dev")
    // Turning TLS on without pasting certificates, and none stored.
    const res = await updateEnvironment({}, form({ id: String(local.id), name: "dev", type: "tcp", url: "127.0.0.1:1", tls: "on" }))
    expect(res).toEqual({ error: m.pasteTls })
    expect(decryptTls(await envByName("dev"))).toBeNull()
  })

  it("is for administrators only", async () => {
    const local = await envByName("dev")
    await signIn(ids.alice, "user")
    expect(await updateEnvironment({}, form({ id: String(local.id), name: "hijacked", type: "socket", url: socket }))).toEqual({
      error: common.errors.adminsOnly,
    })
    expect((await envByName("dev")).name).toBe("dev")
  })

  it("edits a Kubernetes environment's name and namespace after checking the cluster", async () => {
    const k8s = await envByName("k8s")
    const res = await updateEnvironment({}, form({ id: String(k8s.id), name: "k8s", type: "kubernetes", kube_namespace: "web" }))
    expect(res).toEqual({ ok: true, message: fmt(m.saved, { name: "k8s" }) })
    expect((await envByName("k8s")).kube_namespace).toBe("web")
    const bad = await updateEnvironment({}, form({ id: String(k8s.id), name: "k8s", type: "kubernetes", kube_namespace: "Not_Valid" }))
    expect(bad.fieldErrors).toHaveProperty("kube_namespace")
    kubeFake.version = async () => Promise.reject(new KubeError("Cannot reach the Kubernetes API (ECONNREFUSED)", 502))
    const down = await updateEnvironment({}, form({ id: String(k8s.id), name: "renamed", type: "kubernetes" }))
    expect(down.error).toBe(fmt(m.couldNotConnect, { error: "Cannot reach the Kubernetes API (ECONNREFUSED)" }))
    expect((await envByName("k8s")).kube_namespace).toBe("web")
  })
})

describe("setEnvironmentAccess", () => {
  it("replaces who may use an environment, closes affected consoles and audits it", async () => {
    const env = await envByName("dev")
    let res = await setEnvironmentAccess({}, form({ id: String(env.id), user: [`${ids.alice}:manager`, String(ids.bob)] }))
    expect(res).toEqual({ ok: true, message: fmt(m.accessUpdated, { name: "dev" }) })
    expect(await grantsOf(env.id)).toEqual([
      { user_id: ids.alice, role: "manager" },
      // A bare id is an operator, as before roles existed.
      { user_id: ids.bob, role: "operator" },
    ])
    expect(await lastAudit()).toEqual({
      username: "root",
      action: "environment.access",
      target: `${env.id}: ${ids.alice}=manager,${ids.bob}=operator`,
    })
    expect(vi.mocked(closeUserExecSessions).mock.calls.map((c) => c[0]).sort()).toEqual([ids.alice, ids.bob].sort())

    // Bob is dropped: his consoles are closed too.
    vi.mocked(closeUserExecSessions).mockClear()
    res = await setEnvironmentAccess({}, form({ id: String(env.id), user: `${ids.alice}:viewer` }))
    expect(res.ok).toBe(true)
    expect(await grantsOf(env.id)).toEqual([{ user_id: ids.alice, role: "viewer" }])
    expect(vi.mocked(closeUserExecSessions).mock.calls.map((c) => c[0]).sort()).toEqual([ids.alice, ids.bob].sort())

    // Nobody: administrators only.
    res = await setEnvironmentAccess({}, form({ id: String(env.id) }))
    expect(res.ok).toBe(true)
    expect(await grantsOf(env.id)).toEqual([])
    expect(await lastAudit()).toMatchObject({ target: `${env.id}: admins only` })
  })

  it("ignores administrators and unknown users", async () => {
    const env = await envByName("dev")
    await setEnvironmentAccess({}, form({ id: String(env.id), user: [`${ids.admin2}:viewer`, "9999:viewer", `${ids.bob}:viewer`] }))
    expect(await grantsOf(env.id)).toEqual([{ user_id: ids.bob, role: "viewer" }])
  })

  it("refuses malformed requests and unknown environments", async () => {
    const env = await envByName("dev")
    for (const values of [
      { id: "x", user: String(ids.bob) },
      { id: String(env.id), user: `${ids.bob}:owner` },
      { id: String(env.id), user: `${ids.bob}:viewer:extra` },
      { id: String(env.id), user: "-1" },
    ]) {
      expect(await setEnvironmentAccess({}, form(values)), JSON.stringify(values)).toEqual({ error: m.invalidRequest })
    }
    expect(await setEnvironmentAccess({}, form({ id: "999", user: String(ids.bob) }))).toEqual({ error: m.notFound })
    expect(await grantsOf(env.id)).toEqual([{ user_id: ids.bob, role: "viewer" }])
  })

  it("is for administrators only, even for a manager of that environment", async () => {
    const env = await envByName("dev")
    await setEnvironmentAccess({}, form({ id: String(env.id), user: `${ids.alice}:manager` }))
    await signIn(ids.alice, "user")
    expect(await setEnvironmentAccess({}, form({ id: String(env.id), user: [`${ids.alice}:manager`, `${ids.bob}:manager`] }))).toEqual({
      error: common.errors.adminsOnly,
    })
    expect(await grantsOf(env.id)).toEqual([{ user_id: ids.alice, role: "manager" }])
  })
})

describe("selectEnvironment", () => {
  it("selects only environments the user may use", async () => {
    const local = await envByName("dev")
    const k8s = await envByName("k8s")
    await signIn(ids.alice, "user")
    expect(await selectEnvironment(k8s.id)).toEqual({ error: m.notFound })
    expect(request.cookies.has(ENV_COOKIE)).toBe(false)
    expect(await selectEnvironment(local.id)).toEqual({ ok: true })
    expect(request.cookies.get(ENV_COOKIE)).toBe(String(local.id))
    expect(await selectEnvironment(-1)).toEqual({ error: m.invalid })
    await signIn(ids.admin, "admin")
    expect(await selectEnvironment(k8s.id)).toEqual({ ok: true })
    resetRequest()
    expect(await selectEnvironment(local.id)).toEqual({ error: common.errors.sessionExpired })
  })
})

describe("deleteEnvironment", () => {
  it("removes an environment with its grants and disconnects its agent", async () => {
    const env = await envByName("edited")
    await setEnvironmentAccess({}, form({ id: String(env.id), user: `${ids.bob}:viewer` }))
    expect(await deleteEnvironment(env.id)).toEqual({ ok: true, message: m.removed })
    expect((await environments()).some((e) => e.id === env.id)).toBe(false)
    expect(await grantsOf(env.id)).toEqual([])
    expect(disconnectAgent).toHaveBeenCalledWith(env.id, expect.any(String))
    expect(await lastAudit()).toEqual({ username: "root", action: "environment.delete", target: String(env.id) })
  })

  it("refuses bad ids and non-administrators", async () => {
    expect(await deleteEnvironment(0)).toEqual({ error: m.invalid })
    expect(await deleteEnvironment(1.5)).toEqual({ error: m.invalid })
    const local = await envByName("dev")
    await signIn(ids.alice, "user")
    expect(await deleteEnvironment(local.id)).toEqual({ error: common.errors.adminsOnly })
    expect((await environments()).some((e) => e.id === local.id)).toBe(true)
  })

  it("keeps the last environment", async () => {
    for (const env of (await environments()).slice(1)) expect((await deleteEnvironment(env.id)).ok, env.name).toBe(true)
    const [last] = await environments()
    expect(await deleteEnvironment(last.id)).toEqual({ error: m.lastEnvironment })
    expect(await environments()).toHaveLength(1)
  })
})

describe("agent environments", () => {
  it("adds one with a key shown once and stored only as a hash", async () => {
    request.headers.set("host", "gantry.example:3000")
    const res = await createAgentEnvironment({}, form({ name: " edge " }))
    expect(res).toMatchObject({ ok: true, message: fmt(m.agentAdded, { name: "edge" }) })
    const enrollment = res.enrollment!
    const env = await envByName("edge")
    expect(enrollment).toMatchObject({ id: env.id, name: "edge", url: "http://gantry.example:3000", insecure: true })
    expect(parseAgentKey(enrollment.key)).toEqual({ environmentId: env.id })
    expect(enrollment.command).toContain(`GANTRY_AGENT_KEY=${enrollment.key}`)
    expect(env).toMatchObject({ type: "agent", url: `agent://${env.id}`, agent_key_hash: hashAgentKey(enrollment.key) })
    expect(JSON.stringify(env)).not.toContain(enrollment.key)
    expect(await lastAudit()).toEqual({ username: "root", action: "environment.create", target: "edge (agent)" })
  })

  it("renames an agent environment (only its name)", async () => {
    const env = await envByName("edge")
    expect(await updateEnvironment({}, form({ id: String(env.id), name: "edge-2", type: "agent" }))).toEqual({
      ok: true,
      message: fmt(m.saved, { name: "edge-2" }),
    })
    expect(await envByName("edge-2")).toMatchObject({ id: env.id, url: env.url, agent_key_hash: env.agent_key_hash })
    // Not into another type.
    expect(await updateEnvironment({}, form({ id: String(env.id), name: "edge-2", type: "socket", url: socket }))).toEqual({ error: m.agentToOther })
  })

  it("rotates the key: the old one stops working and the agent is dropped", async () => {
    const env = await envByName("edge-2")
    const res = await rotateAgentKey(env.id)
    expect(res).toMatchObject({ ok: true, message: fmt(m.keyRotated, { name: "edge-2" }) })
    const after = await envByName("edge-2")
    expect(after.agent_key_hash).not.toBe(env.agent_key_hash)
    expect(after.agent_key_hash).toBe(hashAgentKey(res.enrollment!.key))
    expect(disconnectAgent).toHaveBeenCalledWith(env.id, expect.any(String))
    expect(await lastAudit()).toMatchObject({ action: "environment.agent_key_rotate", target: String(env.id) })
    // Only agent environments have keys.
    const other = (await environments()).find((e) => e.type !== "agent")!
    expect(await rotateAgentKey(other.id)).toEqual({ error: m.agentNotFound })
    expect(await rotateAgentKey(0)).toEqual({ error: m.invalid })
  })

  it("validates the name", async () => {
    expect((await createAgentEnvironment({}, form({ name: "" }))).fieldErrors).toEqual({ name: [m.nameRequired] })
    expect((await createAgentEnvironment({}, new FormData())).fieldErrors).toEqual({ name: [m.nameRequired] })
  })

  it("is for administrators only", async () => {
    const env = await envByName("edge-2")
    await signIn(ids.alice, "user")
    const before = await environments()
    expect(await createAgentEnvironment({}, form({ name: "sneaky" }))).toEqual({ error: common.errors.adminsOnly, enrollment: undefined })
    expect(await rotateAgentKey(env.id)).toEqual({ error: common.errors.adminsOnly, enrollment: undefined })
    expect(await agentConnection(env.id)).toBeNull()
    expect(await environments()).toEqual(before)
  })

  it("reports whether the agent is connected (to administrators)", async () => {
    const env = await envByName("edge-2")
    expect(await agentConnection(env.id)).toEqual({ connected: false, hostname: null, dockerVersion: null })
    expect(await agentConnection(-3)).toBeNull()
  })
})
