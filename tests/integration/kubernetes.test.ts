import fs from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { KubeLiveEvent } from "@/lib/live"
import { parseManifest } from "@/lib/kubernetes/manifest"
import { toPodRows } from "@/lib/kubernetes/rows"
import { kube, type KubeApi } from "@/lib/server/kubernetes/api"
import { parseKubeconfig } from "@/lib/server/kubernetes/connection"
import { closeSession, openOutputStream, writeInput } from "@/lib/server/exec-sessions"
import { openPodExecSession } from "@/lib/server/kubernetes/exec"
import { kubeEventSource } from "@/lib/server/kubernetes/watch"

// The Kubernetes client against a real cluster. Opt-in, and only ever with a
// THROWAWAY cluster (it creates and deletes a namespace):
//   GANTRY_TEST_KUBECONFIG=/tmp/gantry-k8s-e2e.kubeconfig pnpm test tests/integration/kubernetes.test.ts
const KUBECONFIG = process.env.GANTRY_TEST_KUBECONFIG
const NS = `gantry-test-k-it-${Date.now().toString(36)}`

describe.skipIf(!KUBECONFIG)("Kubernetes client (real cluster)", { timeout: 180_000 }, () => {
  let api: KubeApi
  const until = async (check: () => boolean, ms = 90_000) => {
    for (const end = Date.now() + ms; !check(); ) {
      if (Date.now() > end) throw new Error("timed out")
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  beforeAll(async () => {
    const res = parseKubeconfig(fs.readFileSync(KUBECONFIG!, "utf8"))
    if (res.errors) throw new Error(JSON.stringify(res.errors))
    const { server, credentials, insecure } = res.connection
    api = kube({ server, ...credentials, insecure })
    await api.createNamespace(NS)
  })

  afterAll(async () => {
    await api?.deleteNamespace(NS).catch(() => {})
  })

  it("reads the version, nodes and system pods", async () => {
    expect((await api.version()).gitVersion).toMatch(/^v1\./)
    expect((await api.listNodes()).length).toBeGreaterThan(0)
    expect(toPodRows(await api.listPods("kube-system")).some((p) => p.name.startsWith("kube-apiserver-"))).toBe(true)
  })

  it("applies a pod, reads its logs and deletes it", async () => {
    const manifest = parseManifest(`apiVersion: v1
kind: Pod
metadata: {name: hello}
spec:
  terminationGracePeriodSeconds: 1
  containers:
    - name: main
      image: alpine:3
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "echo hello-from-gantry; sleep 300"]
`)
    if (!manifest.ok) throw new Error(manifest.error)
    const [result] = await api.apply(manifest.objects, { namespace: NS, force: false, dryRun: false })
    expect(result).toMatchObject({ status: "created", namespace: NS })

    let logs = ""
    for (let i = 0; i < 60 && !logs.includes("hello-from-gantry"); i++) {
      await new Promise((r) => setTimeout(r, 2_000))
      logs = await api.podLogs(NS, "hello", { container: "main", tailLines: 100 }).catch(() => "")
    }
    expect(logs).toMatch(/^\S+Z hello-from-gantry/m)
    await api.deletePod(NS, "hello")
  })

  it("watches see a pod appear, exec runs a command and logs can be followed", async () => {
    // Live events through the hub source (all watched types, cluster-wide).
    const events: KubeLiveEvent[] = []
    let opened = false
    const abort = new AbortController()
    const source = kubeEventSource(api.target, { fallbackNamespace: null })({ onOpen: () => (opened = true), onEvent: (e) => void (e.type === "kubernetes" && events.push(e)) }, abort.signal)
    await until(() => opened)

    const manifest = parseManifest(`apiVersion: v1
kind: Pod
metadata: {name: ticker}
spec:
  terminationGracePeriodSeconds: 1
  containers:
    - name: main
      image: alpine:3
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "i=0; while true; do i=$((i+1)); echo tick-$i; sleep 1; done"]
`)
    if (!manifest.ok) throw new Error(manifest.error)
    await api.apply(manifest.objects, { namespace: NS, force: false, dryRun: false })
    await until(() => events.some((e) => e.kind === "Pod" && e.action === "added" && e.namespace === NS && e.name === "ticker"))
    await until(() => events.some((e) => e.kind === "Pod" && e.action === "modified" && e.name === "ticker"))
    for (let i = 0; i < 60 && (await api.getPod(NS, "ticker")).status?.phase !== "Running"; i++) await new Promise((r) => setTimeout(r, 1000))

    // Follow: new lines keep arriving on one open stream.
    const follow = new AbortController()
    const res = await api.followPodLogs(NS, "ticker", { container: "main", tailLines: 1 }, follow.signal)
    let text = ""
    res.on("data", (c: Buffer) => (text += c.toString()))
    await until(() => (text.match(/tick-\d+/g) ?? []).length >= 3, 30_000)
    follow.abort()

    // Exec: run a command, read its output and exit code.
    const sid = await openPodExecSession({
      userId: 1,
      target: api.target,
      namespace: NS,
      pod: "ticker",
      container: "main",
      command: ["/bin/sh"],
      cols: 80,
      rows: 24,
    })
    const reader = openOutputStream(sid, 1, new AbortController().signal).getReader()
    let out = ""
    writeInput(sid, 1, "echo gantry-$((6*7))\rexit 3\r")
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += Buffer.from(value).toString()
    }
    expect(out).toContain("gantry-42")
    expect(await closeSession(sid, 1)).toEqual({ exitCode: 3 })

    await api.deletePod(NS, "ticker")
    await until(() => events.some((e) => e.kind === "Pod" && e.action === "deleted" && e.name === "ticker"))
    abort.abort()
    await source
  })
})
