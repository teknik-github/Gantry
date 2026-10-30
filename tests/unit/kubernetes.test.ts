import fs from "node:fs"
import https from "node:https"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"

import { Kysely, SqliteDialect } from "kysely"
import { Migrator } from "kysely/migration"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { MAX_MANIFEST_OBJECTS, parseManifest } from "@/lib/kubernetes/manifest"
import { podStatus, toPodRows, toSecretRows, toWorkloadRows } from "@/lib/kubernetes/rows"
import { eventAffectsPath } from "@/lib/live"
import { KUBERNETES_ENVIRONMENT } from "@/lib/messages"
import { encryptSecret } from "@/lib/server/crypto"
import { migrationProvider } from "@/lib/server/db/migrations"
import type { Database } from "@/lib/server/db/schema"
import { openSqlite } from "@/lib/server/db/sqlite"
import { DockerError } from "@/lib/server/docker/client"
import { environmentTarget } from "@/lib/server/environment-target"
import { kube, type Pod } from "@/lib/server/kubernetes/api"
import { buildRequest, errorFromResponse, KubeError, kubeJson, parseServerUrl } from "@/lib/server/kubernetes/client"
import { parseKubeconfig, parseTokenConnection } from "@/lib/server/kubernetes/connection"
import { credentialSummary, decryptKubeCredentials, encryptKubeCredentials, kubeTarget } from "@/lib/server/kubernetes/target"

import { generateTlsFixtures, type TlsFixtures } from "../helpers/tls-docker-proxy"

let fx: TlsFixtures
beforeAll(() => {
  fx = generateTlsFixtures()
})
afterAll(() => fx?.cleanup())

const b64 = (s: string) => Buffer.from(s).toString("base64")

function kubeconfig(user: Record<string, unknown>, opts: { cluster?: Record<string, unknown>; namespace?: string } = {}) {
  return JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    "current-context": "test",
    clusters: [{ name: "c", cluster: { server: "https://127.0.0.1:6443", "certificate-authority-data": b64(fx.ca), ...opts.cluster } }],
    users: [{ name: "u", user }],
    contexts: [
      { name: "test", context: { cluster: "c", user: "u", ...(opts.namespace ? { namespace: opts.namespace } : {}) } },
      { name: "other", context: { cluster: "c", user: "u", namespace: "team-b" } },
    ],
  })
}

describe("parseKubeconfig", () => {
  it("reads server, CA and token from the current context", () => {
    const res = parseKubeconfig(kubeconfig({ token: "abc.def" }, { namespace: "apps" }))
    expect(res.errors).toBeUndefined()
    expect(res.context).toBe("test")
    expect(res.connection).toMatchObject({
      server: "https://127.0.0.1:6443",
      credentials: { token: "abc.def", ca: expect.stringContaining("BEGIN CERTIFICATE") },
      insecure: false,
      namespace: "apps",
    })
  })

  it("reads an embedded client certificate and key (kind, kubeadm)", () => {
    const res = parseKubeconfig(
      kubeconfig({ "client-certificate-data": b64(fx.client.cert), "client-key-data": b64(fx.client.key) })
    )
    expect(res.connection?.credentials.cert).toContain("BEGIN CERTIFICATE")
    expect(res.connection?.credentials.key).toContain("PRIVATE KEY")
    expect(res.connection?.credentials.token).toBeUndefined()
  })

  it("rejects a key that doesn't match the certificate", () => {
    const res = parseKubeconfig(
      kubeconfig({ "client-certificate-data": b64(fx.client.cert), "client-key-data": b64(fx.rogueClient.key) })
    )
    expect(res.errors?.kubeconfig?.[0]).toMatch(/does not belong/)
  })

  it("uses another context and a namespace override when asked", () => {
    expect(parseKubeconfig(kubeconfig({ token: "t" }), "other").connection?.namespace).toBe("team-b")
    expect(parseKubeconfig(kubeconfig({ token: "t" }), "other", "mine").connection?.namespace).toBe("mine")
    expect(parseKubeconfig(kubeconfig({ token: "t" }), "nope").errors?.kube_context?.[0]).toMatch(/not in the kubeconfig/)
  })

  it("keeps insecure-skip-tls-verify", () => {
    const res = parseKubeconfig(
      kubeconfig({ token: "t" }, { cluster: { "certificate-authority-data": undefined, "insecure-skip-tls-verify": true } })
    )
    expect(res.connection?.insecure).toBe(true)
    expect(res.connection?.credentials.ca).toBeUndefined()
  })

  it.each([
    [{ exec: { command: "aws", args: ["eks", "get-token"] } }, /credential plugin/],
    [{ "auth-provider": { name: "gcp" } }, /credential plugin/],
    [{ tokenFile: "/var/run/token" }, /references a file \(tokenFile\)/],
    [{ "client-certificate": "/home/me/.kube/c.crt", "client-key": "/home/me/.kube/c.key" }, /references a file/],
    [{ username: "admin", password: "x" }, /Basic authentication/],
    [{}, /no token or client certificate/],
  ])("rejects users it can't use: %o", (user, message) => {
    expect(parseKubeconfig(kubeconfig(user)).errors?.kubeconfig?.[0]).toMatch(message)
  })

  it("rejects file references, plain http and junk", () => {
    expect(parseKubeconfig(kubeconfig({ token: "t" }, { cluster: { "certificate-authority": "/ca.crt" } })).errors?.kubeconfig?.[0]).toMatch(
      /CA file/
    )
    expect(parseKubeconfig(kubeconfig({ token: "t" }, { cluster: { server: "http://10.0.0.1:8080" } })).errors?.kubeconfig?.[0]).toMatch(
      /https/
    )
    expect(parseKubeconfig("").errors?.kubeconfig).toBeTruthy()
    expect(parseKubeconfig("just: a: string: [").errors?.kubeconfig?.[0]).toMatch(/Invalid YAML/)
    expect(parseKubeconfig("foo: bar").errors?.kubeconfig?.[0]).toMatch(/Not a kubeconfig/)
  })
})

describe("parseTokenConnection", () => {
  it("accepts server + token + optional CA and normalises the URL", () => {
    const res = parseTokenConnection({ server: "https://k8s.example.com:6443/", token: " tok ", ca: fx.ca, insecure: false, namespace: "" })
    expect(res.connection).toMatchObject({ server: "https://k8s.example.com:6443", credentials: { token: "tok" }, namespace: null })
    expect(res.connection?.credentials.ca).toContain("BEGIN CERTIFICATE")
    const noCa = parseTokenConnection({ server: "https://h:6443", token: "tok", ca: "", insecure: true })
    expect(noCa.connection?.credentials.ca).toBeUndefined()
    expect(noCa.connection?.insecure).toBe(true)
  })

  it("reports field errors without echoing the token", () => {
    const res = parseTokenConnection({ server: "10.0.0.1:6443", token: "has space", ca: "nope", insecure: false, namespace: "Bad_NS" })
    expect(res.errors?.kube_server?.[0]).toBeTruthy()
    expect(res.errors?.kube_token?.[0]).toMatch(/spaces/)
    expect(res.errors?.kube_ca?.[0]).toMatch(/PEM/)
    expect(res.errors?.kube_namespace?.[0]).toBeTruthy()
    expect(JSON.stringify(res)).not.toContain("has space")
    expect(parseTokenConnection({ server: "https://u:p@h:6443", token: "t", ca: "", insecure: false }).errors?.kube_server).toBeTruthy()
  })
})

describe("stored credentials", () => {
  it("encrypts the credentials as one value and decrypts them back", () => {
    const enc = encryptKubeCredentials({ token: "secret-token", ca: fx.ca, cert: "", key: undefined })
    expect(enc).toMatch(/^v1\./)
    expect(enc).not.toContain("secret-token")
    expect(decryptKubeCredentials({ kube_credentials: enc })).toEqual({ token: "secret-token", ca: fx.ca })
    const row = { type: "kubernetes" as const, url: "https://h:6443", kube_credentials: enc, kube_insecure: 1 }
    expect(kubeTarget(row)).toEqual({ server: "https://h:6443", token: "secret-token", ca: fx.ca, cert: null, key: null, insecure: true })
    expect(credentialSummary(row)).toEqual(["token", "CA"])
  })

  it("refuses values from another column and Docker environments", () => {
    const foreign = encryptSecret(JSON.stringify({ token: "x" }), "environment.tls_key")
    expect(() => decryptKubeCredentials({ kube_credentials: foreign })).toThrow(KubeError)
    expect(() => kubeTarget({ type: "tcp", url: "h:2375", kube_credentials: null, kube_insecure: 0 })).toThrow(/not a Kubernetes/)
  })
})

describe("request building", () => {
  it("joins the base path, encodes the query and sets auth and content headers", () => {
    const { options, payload } = buildRequest(
      { server: "https://rancher.example.com/k8s/clusters/c-1/", token: "tok", ca: fx.ca },
      {
        method: "PATCH",
        path: "/apis/apps/v1/namespaces/web/deployments/api",
        query: { fieldManager: "gantry", force: false, dryRun: undefined },
        body: "{}",
        contentType: "application/apply-patch+yaml",
      }
    )
    expect(options.host).toBe("rancher.example.com")
    expect(options.port).toBe(443)
    expect(options.path).toBe("/k8s/clusters/c-1/apis/apps/v1/namespaces/web/deployments/api?fieldManager=gantry&force=false")
    expect(options.headers).toMatchObject({
      Authorization: "Bearer tok",
      "Content-Type": "application/apply-patch+yaml",
      "Content-Length": 2,
      Accept: "application/json",
    })
    expect(payload?.toString()).toBe("{}")
    expect(options.servername).toBe("rancher.example.com")
    expect(options.rejectUnauthorized).toBe(true)
    expect(options.ca).toBe(fx.ca)
    expect(options.cert).toBeUndefined()
  })

  it("verifies IPs without SNI, skips verification only when asked and sends a client cert", () => {
    const { options } = buildRequest(
      { server: "https://127.0.0.1:6443", cert: fx.client.cert, key: fx.client.key, insecure: true },
      { method: "GET", path: "/version", body: { a: 1 } }
    )
    expect(options.path).toBe("/version")
    expect(options.servername).toBeUndefined()
    expect(options.rejectUnauthorized).toBe(false)
    expect(options.cert).toBe(fx.client.cert)
    expect((options.headers as Record<string, unknown>).Authorization).toBeUndefined()
    expect((options.headers as Record<string, unknown>)["Content-Type"]).toBe("application/json")
  })

  it("accepts https only", () => {
    expect(() => parseServerUrl("http://h:8080")).toThrow(/https/)
    expect(() => parseServerUrl("not a url")).toThrow(KubeError)
    expect(() => parseServerUrl("https://h:6443?x=1")).toThrow(/query/)
  })

  it("turns Status objects into messages", () => {
    const status = JSON.stringify({ kind: "Status", message: 'pods is forbidden: User "x" cannot list', reason: "Forbidden", code: 403 })
    const err = errorFromResponse(403, status)
    expect(err.message).toBe('pods is forbidden: User "x" cannot list')
    expect(err.reason).toBe("Forbidden")
    expect(errorFromResponse(401, "Unauthorized").message).toMatch(/rejected the credentials/)
    expect(errorFromResponse(500, "").message).toBe("Kubernetes API error 500")
  })
})

describe("parseManifest", () => {
  it("splits documents, skips empty ones and expands Lists", () => {
    const res = parseManifest(`---
apiVersion: v1
kind: Namespace
metadata:
  name: demo
---
# just a comment
---
apiVersion: v1
kind: List
items:
  - apiVersion: v1
    kind: ConfigMap
    metadata: { name: a, namespace: demo }
  - apiVersion: apps/v1
    kind: Deployment
    metadata: { name: b }
`)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.objects.map((o) => [o.index, o.apiVersion, o.kind, o.name, o.namespace])).toEqual([
      [1, "v1", "Namespace", "demo", null],
      [2, "v1", "ConfigMap", "a", "demo"],
      [3, "apps/v1", "Deployment", "b", null],
    ])
  })

  it.each([
    ["", /empty/],
    ["# nothing\n---\n", /no objects/],
    ["kind: Pod\nmetadata: {name: x}", /apiVersion/],
    ["apiVersion: v1\nmetadata: {name: x}", /kind/],
    ["apiVersion: v1\nkind: Pod\nmetadata: {generateName: x-}", /metadata.name/],
    ["apiVersion: v1\nkind: Pod\nmetadata: {name: x}\nmetadata: {name: y}", /Document 1: invalid YAML/],
    ["- a\n- b", /must be a mapping/],
    ["apiVersion: v1\nkind: Pod\nmetadata: {name: x, namespace: 3}", /namespace must be a string/],
  ])("rejects %j", (text, message) => {
    const res = parseManifest(text)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(message)
  })

  it("limits the number of objects", () => {
    const doc = (i: number) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: c${i}\n`
    const text = Array.from({ length: MAX_MANIFEST_OBJECTS + 1 }, (_, i) => doc(i)).join("---\n")
    expect(parseManifest(text)).toMatchObject({ ok: false, error: expect.stringMatching(/At most/) })
  })
})

describe("rows", () => {
  const pod = (status: Pod["status"], extra: Partial<Pod["metadata"]> = {}): Pod => ({
    metadata: { name: "p", namespace: "ns", ...extra },
    spec: { containers: [{ name: "a" }, { name: "b" }], nodeName: "n1" },
    status,
  })

  it("derives kubectl-style pod status", () => {
    expect(podStatus(pod({ phase: "Running", containerStatuses: [{ name: "a", ready: true, restartCount: 0, state: { running: {} } }] }))).toBe("Running")
    expect(
      podStatus(pod({ phase: "Running", containerStatuses: [{ name: "a", ready: false, restartCount: 5, state: { waiting: { reason: "CrashLoopBackOff" } } }] }))
    ).toBe("CrashLoopBackOff")
    expect(podStatus(pod({ phase: "Succeeded", containerStatuses: [{ name: "a", ready: false, restartCount: 0, state: { terminated: { reason: "Completed", exitCode: 0 } } }] }))).toBe(
      "Completed"
    )
    expect(podStatus(pod({ phase: "Pending", initContainerStatuses: [{ name: "i", ready: false, restartCount: 0, state: { waiting: { reason: "ErrImagePull" } } }] }))).toBe(
      "Init:ErrImagePull"
    )
    expect(podStatus(pod({ phase: "Running" }, { deletionTimestamp: "2026-01-01T00:00:00Z" }))).toBe("Terminating")
    expect(podStatus(pod({ phase: "Failed", reason: "Evicted" }))).toBe("Evicted")
  })

  it("counts ready containers and restarts", () => {
    const [row] = toPodRows([
      pod({
        phase: "Running",
        containerStatuses: [
          { name: "a", ready: true, restartCount: 2, state: { running: {} } },
          { name: "b", ready: false, restartCount: 1, state: { running: {} } },
        ],
      }),
    ])
    expect(row).toMatchObject({ id: "ns/p", ready: "1/2", restarts: 3, node: "n1", containers: ["a", "b"] })
  })

  it("uses the DaemonSet status fields", () => {
    const [ds] = toWorkloadRows("DaemonSet", [
      { metadata: { name: "d", namespace: "kube-system" }, status: { desiredNumberScheduled: 3, numberReady: 2, updatedNumberScheduled: 3 } },
    ])
    expect(ds).toMatchObject({ id: "DaemonSet/kube-system/d", ready: 2, desired: 3, upToDate: 3 })
    const [dep] = toWorkloadRows("Deployment", [{ metadata: { name: "x", namespace: "a" }, spec: { replicas: 2 }, status: {} }])
    expect(dep).toMatchObject({ ready: 0, desired: 2 })
  })

  it("keeps only key names of secrets", () => {
    const rows = toSecretRows([{ metadata: { name: "s", namespace: "n" }, type: "Opaque", keys: ["b", "a"] }])
    expect(rows).toEqual([{ id: "n/s", name: "s", namespace: "n", type: "Opaque", keys: ["a", "b"], created: "" }])
  })
})

/**
 * A fake API server over TLS (certificate from the test CA), enough to
 * exercise the real client: auth, CA verification, discovery, apply and
 * the secret filtering.
 */
describe("client against a fake API server", () => {
  let server: https.Server
  let url = ""
  const seen: { method: string; url: string; auth?: string; type?: string; body: string; cert: boolean }[] = []

  beforeAll(async () => {
    server = https.createServer(
      { cert: fx.server.cert, key: fx.server.key, ca: fx.ca, requestCert: true, rejectUnauthorized: false },
      (req, res) => {
        const chunks: Buffer[] = []
        req.on("data", (c) => chunks.push(c))
        req.on("end", () => {
          const sock = req.socket as import("node:tls").TLSSocket
          seen.push({
            method: req.method!,
            url: req.url!,
            auth: req.headers.authorization,
            type: req.headers["content-type"],
            body: Buffer.concat(chunks).toString(),
            cert: sock.authorized,
          })
          const json = (status: number, body: unknown) => {
            res.writeHead(status, { "Content-Type": "application/json" })
            res.end(JSON.stringify(body))
          }
          if (req.headers.authorization !== "Bearer good" && !sock.authorized) {
            return json(401, { kind: "Status", message: "Unauthorized", code: 401 })
          }
          const path = req.url!.split("?")[0]
          if (path === "/version") return json(200, { gitVersion: "v1.34.0" })
          if (path === "/api/v1/secrets")
            return json(200, { items: [{ metadata: { name: "s", namespace: "n" }, type: "Opaque", data: { password: b64("hunter2") } }] })
          if (path === "/api/v1") return json(200, { resources: [{ name: "configmaps", kind: "ConfigMap", namespaced: true }, { name: "namespaces", kind: "Namespace", namespaced: false }, { name: "pods/log", kind: "Pod", namespaced: true }] })
          if (path === "/apis/apps/v1") return json(200, { resources: [{ name: "deployments", kind: "Deployment", namespaced: true }] })
          if (path.startsWith("/apis/example.com/")) return json(404, { kind: "Status", message: "not found", reason: "NotFound", code: 404 })
          if (req.method === "PATCH" && path === "/apis/apps/v1/namespaces/web/deployments/taken") {
            return json(409, { kind: "Status", message: 'Apply failed with 1 conflict: conflict with "kubectl"', reason: "Conflict", code: 409 })
          }
          if (req.method === "PATCH") return json(path.endsWith("/new") ? 201 : 200, JSON.parse(Buffer.concat(chunks).toString() || "{}"))
          json(404, { kind: "Status", message: `${path} not found`, reason: "NotFound", code: 404 })
        })
      }
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it("talks to the server verified by the CA, with the token", async () => {
    const res = await kubeJson<{ gitVersion: string }>({ server: url, token: "good", ca: fx.ca }, { method: "GET", path: "/version" })
    expect(res.data.gitVersion).toBe("v1.34.0")
    expect(seen.at(-1)).toMatchObject({ auth: "Bearer good", cert: false })
  })

  it("authenticates with a client certificate", async () => {
    await kube({ server: url, cert: fx.client.cert, key: fx.client.key, ca: fx.ca }).version()
    expect(seen.at(-1)).toMatchObject({ cert: true, auth: undefined })
  })

  it("refuses a server its CA didn't sign unless verification is off", async () => {
    await expect(kube({ server: url, token: "good", ca: fx.rogueCa }).version()).rejects.toThrow(/TLS handshake/)
    await expect(kube({ server: url, token: "good" }).version()).rejects.toThrow(/TLS handshake/)
    await expect(kube({ server: url, token: "good", insecure: true }).version()).resolves.toMatchObject({ gitVersion: "v1.34.0" })
  })

  it("reports rejected credentials and unreachable servers", async () => {
    await expect(kube({ server: url, token: "bad", ca: fx.ca }).version()).rejects.toMatchObject({ status: 401 })
    await expect(kube({ server: "https://127.0.0.1:1", token: "x" }).version()).rejects.toThrow(/Cannot reach/)
  })

  it("drops secret values as soon as they arrive", async () => {
    const secrets = await kube({ server: url, token: "good", ca: fx.ca }).listSecrets(null)
    expect(secrets).toEqual([{ metadata: { name: "s", namespace: "n", creationTimestamp: undefined }, type: "Opaque", keys: ["password"] }])
    expect(JSON.stringify(secrets)).not.toContain(b64("hunter2"))
  })

  it("applies objects with server-side apply and reports each one", async () => {
    const manifest = parseManifest(`apiVersion: v1
kind: Namespace
metadata: {name: web, namespace: ignored}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: new}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: cm, namespace: web}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: taken}
---
apiVersion: v1
kind: ConfigMap
metadata: {name: elsewhere, namespace: other}
---
apiVersion: example.com/v1
kind: Widget
metadata: {name: w}
---
apiVersion: apps/v1
kind: Gadget
metadata: {name: g}
`)
    if (!manifest.ok) throw new Error(manifest.error)
    seen.length = 0
    const results = await kube({ server: url, token: "good", ca: fx.ca }).apply(manifest.objects, { namespace: "web", force: false, dryRun: false })
    expect(results.map((r) => [r.kind, r.name, r.namespace, r.status])).toEqual([
      ["Namespace", "web", null, "configured"],
      ["Deployment", "new", "web", "created"],
      ["ConfigMap", "cm", "web", "configured"],
      ["Deployment", "taken", "web", "error"],
      ["ConfigMap", "elsewhere", "other", "error"],
      ["Widget", "w", null, "error"],
      ["Gadget", "g", null, "error"],
    ])
    expect(results[3].message).toMatch(/conflict/)
    expect(results[4].message).toMatch(/doesn't match the chosen namespace/)
    expect(results[5].message).toMatch(/not served/)
    expect(results[6].message).toMatch(/not part of apps\/v1/)

    const patches = seen.filter((s) => s.method === "PATCH")
    expect(patches.map((p) => p.url)).toEqual([
      "/api/v1/namespaces/web?fieldManager=gantry&force=false",
      "/apis/apps/v1/namespaces/web/deployments/new?fieldManager=gantry&force=false",
      "/api/v1/namespaces/web/configmaps/cm?fieldManager=gantry&force=false",
      "/apis/apps/v1/namespaces/web/deployments/taken?fieldManager=gantry&force=false",
    ])
    expect(patches.every((p) => p.type === "application/apply-patch+yaml")).toBe(true)
    // Cluster-scoped objects lose the namespace; namespaced ones get the chosen one.
    expect(JSON.parse(patches[0].body).metadata.namespace).toBeUndefined()
    expect(JSON.parse(patches[1].body).metadata.namespace).toBe("web")
    // Discovery is asked once per apiVersion.
    expect(seen.filter((s) => s.url === "/apis/apps/v1").length).toBe(1)
  })

  it("passes force and dry run", async () => {
    const manifest = parseManifest("apiVersion: v1\nkind: ConfigMap\nmetadata: {name: cm}\n")
    if (!manifest.ok) throw new Error(manifest.error)
    seen.length = 0
    await kube({ server: url, token: "good", ca: fx.ca }).apply(manifest.objects, { namespace: "web", force: true, dryRun: true })
    expect(seen.find((s) => s.method === "PATCH")?.url).toBe("/api/v1/namespaces/web/configmaps/cm?fieldManager=gantry&force=true&dryRun=All")
  })
})

describe("Docker features and Kubernetes environments", () => {
  it("never builds a Docker target for a cluster", () => {
    const row = { type: "kubernetes" as const, url: "https://h:6443", tls_ca: null, tls_cert: null, tls_key: null }
    expect(() => environmentTarget(row)).toThrow(DockerError)
    expect(() => environmentTarget(row)).toThrow(KUBERNETES_ENVIRONMENT)
  })

  it("Docker events don't refresh Kubernetes pages", () => {
    expect(eventAffectsPath({ type: "container", action: "start", id: "abc" }, "/kubernetes/pods")).toBe(false)
  })

  it("migration 009 adds the columns; background tasks can select Docker environments only", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-k-db-"))
    const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: openSqlite(path.join(dir, "t.db")) }) })
    try {
      const { error } = await new Migrator({ db, provider: migrationProvider }).migrateToLatest()
      expect(error).toBeUndefined()
      const now = new Date().toISOString()
      // 001 seeds the "local" socket environment.
      await db
        .insertInto("environments")
        .values({
          name: "kind",
          type: "kubernetes",
          url: "https://127.0.0.1:6443",
          kube_credentials: encryptKubeCredentials({ token: "t" }),
          kube_namespace: "apps",
          kube_insecure: 1,
          created_at: now,
        })
        .execute()
      const local = await db.selectFrom("environments").selectAll().where("type", "=", "socket").executeTakeFirstOrThrow()
      expect(local).toMatchObject({ kube_credentials: null, kube_namespace: null, kube_insecure: 0 })
      const kind = await db.selectFrom("environments").selectAll().where("name", "=", "kind").executeTakeFirstOrThrow()
      expect(kubeTarget(kind)).toMatchObject({ server: "https://127.0.0.1:6443", token: "t", insecure: true })
      // The query the metrics sampler and the update checker use.
      const docker = await db.selectFrom("environments").select("name").where("type", "!=", "kubernetes").execute()
      expect(docker.map((e) => e.name)).toEqual([local.name])
    } finally {
      await db.destroy()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
