import fs from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseManifest } from "@/lib/kubernetes/manifest"
import { toPodRows } from "@/lib/kubernetes/rows"
import { kube, type KubeApi } from "@/lib/server/kubernetes/api"
import { parseKubeconfig } from "@/lib/server/kubernetes/connection"

// The Kubernetes client against a real cluster. Opt-in, and only ever with a
// THROWAWAY cluster (it creates and deletes a namespace):
//   GANTRY_TEST_KUBECONFIG=/tmp/gantry-k8s-e2e.kubeconfig pnpm test tests/integration/kubernetes.test.ts
const KUBECONFIG = process.env.GANTRY_TEST_KUBECONFIG
const NS = `gantry-test-k-it-${Date.now().toString(36)}`

describe.skipIf(!KUBECONFIG)("Kubernetes client (real cluster)", { timeout: 180_000 }, () => {
  let api: KubeApi

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
})
