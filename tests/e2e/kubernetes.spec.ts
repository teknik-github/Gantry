import { execFileSync } from "node:child_process"
import fs from "node:fs"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"

import { expect, test, type Page } from "@playwright/test"
import { parse } from "yaml"

import { ADMIN } from "./credentials"

// Runs after the "login" project, which creates the ADMIN account.
//
// Needs a THROWAWAY cluster, e.g. kind:
//   kind create cluster --name gantry-k8s-e2e --kubeconfig /tmp/gantry-k8s-e2e.kubeconfig
//   GANTRY_E2E_KUBECONFIG=/tmp/gantry-k8s-e2e.kubeconfig pnpm test:e2e tests/e2e/kubernetes.spec.ts
// Never point it at a real cluster: the suite creates and deletes a
// namespace. GANTRY_E2E_KUBE_TOKEN (a service account token with
// cluster-admin) additionally tests the token form. The workload uses
// alpine:3 (load it into the cluster to avoid a pull).
test.describe.configure({ mode: "serial" })

const KUBECONFIG = process.env.GANTRY_E2E_KUBECONFIG
const TOKEN = process.env.GANTRY_E2E_KUBE_TOKEN
const ENV = "gantry-test-k-kind"
const NS = `gantry-test-k-${Date.now().toString(36)}`
const APP = "gantry-e2e-hello"
const SECRET_VALUE = `s3cr3t-${Date.now().toString(36)}-gantry`
/** Namespace for the live update, exec, log follow and Helm tests. */
const LIVE_NS = `gantry-test-k-live-${Date.now().toString(36)}`
const RELEASE = "gantry-e2e-demo"

const MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${APP}
spec:
  replicas: 1
  selector:
    matchLabels: { app: ${APP} }
  template:
    metadata:
      labels: { app: ${APP} }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: main
          image: alpine:3
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "echo hello-from-gantry; sleep 3600"]
---
apiVersion: v1
kind: Secret
metadata:
  name: ${APP}
stringData:
  password: ${SECRET_VALUE}
---
apiVersion: v1
kind: Service
metadata:
  name: ${APP}
spec:
  selector: { app: ${APP} }
  ports:
    - port: 8080
      targetPort: 80
`

type Cluster = { server: string; ca: string; cert: string; key: string }

/** Server, CA and admin client certificate from the kubeconfig's current context. */
function readCluster(): Cluster {
  const cfg = parse(fs.readFileSync(KUBECONFIG!, "utf8"))
  const ctx = cfg.contexts.find((c: { name: string }) => c.name === cfg["current-context"]).context
  const cluster = cfg.clusters.find((c: { name: string }) => c.name === ctx.cluster).cluster
  const user = cfg.users.find((u: { name: string }) => u.name === ctx.user).user
  const dec = (s: string) => Buffer.from(s, "base64").toString("utf8")
  return {
    server: cluster.server,
    ca: dec(cluster["certificate-authority-data"]),
    cert: dec(user["client-certificate-data"]),
    key: dec(user["client-key-data"]),
  }
}

/** Direct API call for setup checks and cleanup (not through Gantry). */
function kubeApi(cluster: Cluster, method: string, path: string, body?: unknown): Promise<{ status: number; body: string }> {
  const url = new URL(cluster.server)
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path,
        ca: cluster.ca,
        cert: cluster.cert,
        key: cluster.key,
        headers: payload ? { "Content-Type": "application/json" } : {},
      },
      (res) => {
        let body = ""
        res.on("data", (c) => (body += c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      }
    )
    req.on("error", reject)
    req.end(payload)
  })
}

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function switchEnvironment(page: Page, name: string) {
  await page.locator('[data-sidebar="header"]').getByRole("button").first().click()
  await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click()
}

async function signInToCluster(page: Page) {
  await signIn(page)
  await switchEnvironment(page, ENV)
  await expect(page).toHaveURL(/\/kubernetes$/)
}

async function pickNamespace(page: Page, ns: string) {
  await page.getByRole("combobox", { name: "Namespace" }).click()
  await page.getByRole("option", { name: ns, exact: true }).click()
  await expect(page.getByRole("combobox", { name: "Namespace" })).toHaveText(ns)
}

/** Kubernetes pages don't update live: reload until the assertion holds. */
async function eventually(page: Page, assertion: () => Promise<void>, timeout = 120_000) {
  await expect(async () => {
    await page.reload()
    await assertion()
  }).toPass({ timeout, intervals: [2_000, 3_000, 5_000] })
}

let cluster: Cluster

test.beforeAll(async () => {
  test.skip(!KUBECONFIG, "GANTRY_E2E_KUBECONFIG not set (needs a throwaway cluster)")
  cluster = readCluster()
  const version = await kubeApi(cluster, "GET", "/version").catch(() => null)
  test.skip(version?.status !== 200, "the test cluster is not reachable")
})

const VIEWER = { username: "gantry-test-k-viewer", password: "e2e-K8s-Viewer-Passw0rd" }
const VIEWER_ENV = "gantry-test-k-readonly"
const VIEWER_SA = "gantry-test-k-viewer"

test.afterAll(async () => {
  if (!cluster) return
  await kubeApi(cluster, "DELETE", `/api/v1/namespaces/${NS}`).catch(() => {})
  await kubeApi(cluster, "DELETE", `/api/v1/namespaces/${LIVE_NS}`).catch(() => {})
  await kubeApi(cluster, "DELETE", `/apis/rbac.authorization.k8s.io/v1/namespaces/default/rolebindings/${VIEWER_SA}`).catch(() => {})
  await kubeApi(cluster, "DELETE", `/api/v1/namespaces/default/serviceaccounts/${VIEWER_SA}`).catch(() => {})
})

test("admin adds a cluster from a kubeconfig; bad credentials are refused", async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page)
  await page.goto("/environments")

  // A token the cluster rejects is caught by the connection check.
  await page.getByRole("button", { name: "Add environment" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name", { exact: true }).fill(ENV)
  await dialog.getByRole("combobox", { name: "Connection" }).click()
  await page.getByRole("option", { name: "Kubernetes (API server)" }).click()
  await dialog.getByLabel("API server URL").fill(cluster.server)
  await dialog.getByLabel("Bearer token").fill("not-a-valid-token")
  await dialog.getByLabel("CA certificate", { exact: true }).fill(cluster.ca)
  await dialog.getByRole("button", { name: "Connect" }).click()
  await expect(dialog.getByText(/Could not connect: The Kubernetes API rejected the credentials/)).toBeVisible()

  // Kubeconfig with the cluster's client certificate (kind's admin user).
  await dialog.getByRole("radio", { name: "Kubeconfig" }).click()
  await dialog.getByLabel("Kubeconfig", { exact: true }).fill(fs.readFileSync(KUBECONFIG!, "utf8"))
  await dialog.getByRole("button", { name: "Connect" }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })

  const row = page.getByRole("row", { name: new RegExp(ENV) })
  await expect(row).toContainText("up · Kubernetes v1.")
  await expect(row).toContainText("client certificate")
  // The private key never reaches the browser.
  expect(await page.content()).not.toContain(cluster.key.split("\n")[1])

  if (TOKEN) {
    // Switch the stored connection to a service account token.
    await row.getByRole("button", { name: "Edit environment" }).click()
    await dialog.getByRole("button", { name: "Replace" }).click()
    await dialog.getByLabel("API server URL").fill(cluster.server)
    await dialog.getByLabel("Bearer token").fill(TOKEN)
    await dialog.getByLabel("CA certificate", { exact: true }).fill(cluster.ca)
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    await expect(row).toContainText("token")
    await expect(row).toContainText("up · Kubernetes v1.")
    expect(await page.content()).not.toContain(TOKEN.slice(20, 60))
  }
})

test("switching to the cluster shows the Kubernetes pages", async ({ page }) => {
  await signInToCluster(page)
  await expect(page.getByRole("heading", { name: `Cluster: ${ENV}` })).toBeVisible()
  await expect(page.getByTestId("card-nodes")).toContainText("1/1")
  await expect(page.getByRole("row", { name: /control-plane/ }).first()).toContainText("Ready")

  const sidebar = page.locator('[data-sidebar="sidebar"]')
  await expect(sidebar.getByRole("link", { name: "Workloads" })).toBeVisible()
  await expect(sidebar.getByRole("link", { name: "Containers" })).toHaveCount(0)

  // Docker pages explain instead of failing.
  await page.goto("/containers")
  await expect(page.getByTestId("wrong-environment-kind")).toContainText("This is a Kubernetes environment")
  await page.goto("/stacks")
  await expect(page.getByTestId("wrong-environment-kind")).toBeVisible()

  // System pods are listed.
  await page.goto("/kubernetes/pods")
  await pickNamespace(page, "kube-system")
  await expect(page.getByRole("link", { name: /^kube-apiserver-/ })).toBeVisible()
})

test("create a namespace, apply a manifest, scale, read logs, delete", async ({ page }) => {
  test.setTimeout(300_000)
  await signInToCluster(page)
  await page.goto("/kubernetes/namespaces")
  await expect(page.getByRole("heading", { name: "Namespaces", level: 2 })).toBeVisible()

  await page.getByRole("button", { name: "Create namespace" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name", { exact: true }).fill(NS)
  await dialog.getByRole("button", { name: "Create" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("row", { name: new RegExp(NS) })).toBeVisible()

  // Apply: Deployment + Service into the new namespace.
  await page.goto("/kubernetes/apply")
  await page.getByRole("combobox", { name: "Namespace" }).click()
  await page.getByRole("option", { name: NS, exact: true }).click()
  await page.getByRole("textbox", { name: "Manifest" }).fill(MANIFEST)
  await page.getByRole("button", { name: "Apply", exact: true }).click()
  const results = page.getByTestId("apply-results")
  await expect(results.getByRole("row", { name: new RegExp(`Deployment/${APP}`) })).toContainText("created")
  await expect(results.getByRole("row", { name: new RegExp(`Service/${APP}`) })).toContainText("created")
  await expect(results.getByRole("row", { name: new RegExp(`Secret/${APP}`) })).toContainText("created")

  // Applying again changes nothing but succeeds.
  await page.getByRole("button", { name: "Apply", exact: true }).click()
  await expect(results.getByRole("row", { name: new RegExp(`Deployment/${APP}`) })).toContainText("configured")

  // Workloads: ready, then scaled to 2.
  await page.goto("/kubernetes/workloads")
  await pickNamespace(page, NS)
  const ready = page.getByTestId(`workload-ready-${APP}`)
  await eventually(page, () => expect(ready).toHaveText("1/1", { timeout: 2_000 }))
  const row = page.getByRole("row", { name: new RegExp(APP) })
  await row.getByRole("button", { name: "Scale" }).click()
  await dialog.getByRole("spinbutton", { name: "Replicas" }).fill("2")
  await dialog.getByRole("button", { name: "Scale" }).click()
  await expect(dialog).toBeHidden()
  await eventually(page, () => expect(ready).toHaveText("2/2", { timeout: 2_000 }))

  // Services list the new service.
  await page.goto("/kubernetes/services")
  await expect(page.getByRole("row", { name: new RegExp(APP) })).toContainText("ClusterIP")
  await expect(page.getByRole("row", { name: new RegExp(APP) })).toContainText("8080→80")

  // Secrets: the key is listed, the value is not in the page (fresh load, no hidden pages).
  await page.goto("/kubernetes/config")
  await expect(page.getByRole("row", { name: new RegExp(APP) }).filter({ hasText: "Opaque" })).toContainText("password")
  const html = await page.content()
  expect(html).not.toContain(SECRET_VALUE)
  expect(html).not.toContain(Buffer.from(SECRET_VALUE).toString("base64"))

  // Pod logs.
  await page.goto("/kubernetes/pods")
  await page.getByRole("link", { name: new RegExp(`^${APP}-`) }).first().click()
  await expect(page).toHaveURL(new RegExp(`/kubernetes/pods/${NS}/${APP}-`))
  await expect(page.getByTestId("pod-logs")).toContainText("hello-from-gantry")

  // Delete the deployment.
  await page.goto("/kubernetes/workloads")
  await page.getByRole("row", { name: new RegExp(APP) }).getByRole("button", { name: "Delete" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText(`Deployment ${APP} deleted`)).toBeVisible()
  await eventually(page, () => expect(page.getByRole("row", { name: new RegExp(APP) })).toHaveCount(0, { timeout: 2_000 }))

  // Everything is in the activity log.
  await page.goto("/activity")
  for (const action of ["kubernetes.namespace.create", "kubernetes.apply", "kubernetes.scale", "kubernetes.delete"]) {
    await expect(page.getByRole("cell", { name: action, exact: true }).first()).toBeVisible()
  }

  // Delete the namespace.
  await page.goto("/kubernetes/namespaces")
  await page.getByRole("row", { name: new RegExp(NS) }).getByRole("button", { name: "Delete namespace" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText(`Deleting namespace ${NS}`)).toBeVisible()
  await eventually(page, async () => {
    const res = await kubeApi(cluster, "GET", `/api/v1/namespaces/${NS}`)
    expect(res.status === 404 || JSON.parse(res.body).status?.phase === "Terminating").toBe(true)
  })
})

/** kubectl with the test cluster's kubeconfig when it is installed; else the same request through the API. */
function hasCommand(cmd: string) {
  try {
    execFileSync("sh", ["-c", `${cmd} version ${cmd === "kubectl" ? "--client" : "--short"} >/dev/null 2>&1`])
    return true
  } catch {
    return false
  }
}

/**
 * `kubectl apply` of a manifest with the test kubeconfig only. Run through sh
 * with a file: a snap-packaged kubectl misbehaves on Node's stdio pipes.
 */
function kubectlApply(manifest: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-k-kubectl-"))
  try {
    const file = path.join(dir, "manifest.yaml")
    fs.writeFileSync(file, manifest)
    execFileSync("sh", ["-c", 'out=$(kubectl --kubeconfig "$1" apply -f "$2" 2>&1); code=$?; printf "%s\\n" "$out"; exit $code', "sh", KUBECONFIG!, file], {
      env: { ...process.env, KUBECONFIG: "" },
    })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const TICKER = `apiVersion: v1
kind: Pod
metadata:
  name: ticker
  namespace: ${LIVE_NS}
spec:
  terminationGracePeriodSeconds: 1
  containers:
    - name: main
      image: alpine:3
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "i=0; while true; do i=$((i+1)); echo tick-$i; sleep 1; done"]
`

test("pods appear live, logs follow, and the console runs commands", async ({ page }) => {
  test.setTimeout(240_000)
  await kubeApi(cluster, "POST", "/api/v1/namespaces", { metadata: { name: LIVE_NS } })
  await signInToCluster(page)
  await page.goto("/kubernetes/pods")
  await pickNamespace(page, LIVE_NS)
  await expect(page.getByText("No pods.")).toBeVisible()
  await expect(page.getByTestId("live-indicator")).toHaveAttribute("data-status", "connected")

  // Created outside Gantry: the list updates from the watch, without a reload.
  if (hasCommand("kubectl")) {
    kubectlApply(TICKER)
  } else {
    const doc = parse(TICKER)
    await kubeApi(cluster, "POST", `/api/v1/namespaces/${LIVE_NS}/pods`, doc)
  }
  const row = page.getByRole("row", { name: /ticker/ })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toContainText("Running", { timeout: 90_000 })

  // Logs are followed: new lines arrive on the open stream.
  await row.getByRole("link", { name: "ticker" }).click()
  const logs = page.getByTestId("pod-logs")
  await expect(logs).toHaveAttribute("data-state", "streaming")
  await expect(logs).toContainText(/tick-\d+/)
  const last = async () => Math.max(...((await logs.textContent()) ?? "").match(/tick-(\d+)/g)!.map((t) => Number(t.slice(5))))
  const first = await last()
  await expect.poll(last, { timeout: 15_000 }).toBeGreaterThan(first + 2)

  // Console: kubectl exec through a WebSocket to the API server.
  const terminal = page.getByTestId("exec-terminal").locator(".xterm-rows")
  await page.getByRole("button", { name: "Connect" }).click()
  await expect(page.getByText("Connected", { exact: true })).toBeVisible()
  await page.getByTestId("exec-terminal").click()
  await page.keyboard.type("echo gantry-$((6*7))")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("gantry-42")
  await page.keyboard.type("exit 3")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("[process exited with code 3]")

  await page.goto("/activity")
  await expect(page.getByRole("cell", { name: "kubernetes.exec", exact: true }).first()).toBeVisible()
})

/** A one-ConfigMap chart, installed with the helm CLI if present, else as the release record Helm would write. */
async function installRelease() {
  const chart = { name: "gantry-e2e-chart", version: "0.1.0", appVersion: "1.0.0" }
  const configMap = `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${RELEASE}-config
data:
  greeting: hello`
  if (hasCommand("helm")) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-k-helm-"))
    try {
      fs.mkdirSync(path.join(dir, "chart/templates"), { recursive: true })
      fs.writeFileSync(path.join(dir, "chart/Chart.yaml"), `apiVersion: v2\nname: ${chart.name}\nversion: ${chart.version}\nappVersion: "${chart.appVersion}"\n`)
      fs.writeFileSync(path.join(dir, "chart/values.yaml"), "greeting: hello\n")
      fs.writeFileSync(path.join(dir, "chart/templates/cm.yaml"), configMap.replace("greeting: hello", "greeting: {{ .Values.greeting }}"))
      // Private helm dirs and an explicit kubeconfig: nothing of the user's is read or written.
      const env = { ...process.env, KUBECONFIG: "", HELM_CACHE_HOME: path.join(dir, "cache"), HELM_CONFIG_HOME: path.join(dir, "config"), HELM_DATA_HOME: path.join(dir, "data") }
      execFileSync("helm", ["install", RELEASE, path.join(dir, "chart"), "--kubeconfig", KUBECONFIG!, "--namespace", LIVE_NS, "--set", "greeting=hello"], { env, stdio: "pipe" })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    return
  }
  await kubeApi(cluster, "POST", `/api/v1/namespaces/${LIVE_NS}/configmaps`, parse(configMap))
  const record = {
    name: RELEASE,
    namespace: LIVE_NS,
    version: 1,
    info: { status: "deployed", last_deployed: new Date().toISOString(), description: "Install complete" },
    chart: { metadata: { name: chart.name, version: chart.version, appVersion: chart.appVersion } },
    config: { greeting: "hello" },
    manifest: `---\n# Source: ${chart.name}/templates/cm.yaml\n${configMap}\n`,
  }
  const release = zlib.gzipSync(Buffer.from(JSON.stringify(record))).toString("base64")
  await kubeApi(cluster, "POST", `/api/v1/namespaces/${LIVE_NS}/secrets`, {
    metadata: { name: `sh.helm.release.v1.${RELEASE}.v1`, labels: { owner: "helm", name: RELEASE, version: "1", status: "deployed" } },
    type: "helm.sh/release.v1",
    data: { release: Buffer.from(release).toString("base64") },
  })
}

test("Helm releases are listed, shown and uninstalled", async ({ page }) => {
  test.setTimeout(180_000)
  await installRelease()
  await signInToCluster(page)
  await page.goto("/kubernetes/helm")
  await pickNamespace(page, LIVE_NS)
  const row = page.getByRole("row", { name: new RegExp(RELEASE) })
  await expect(row).toContainText("gantry-e2e-chart-0.1.0")
  await expect(row).toContainText("1.0.0")
  await expect(page.getByTestId(`helm-status-${RELEASE}`)).toContainText("deployed")

  await row.getByRole("link", { name: RELEASE }).click()
  await expect(page.getByTestId("helm-values")).toContainText("greeting: hello")
  await expect(page.getByTestId("helm-manifest")).toContainText(`name: ${RELEASE}-config`)

  await page.getByRole("button", { name: "Uninstall" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Uninstall" }).click()
  await expect(page).toHaveURL(/\/kubernetes\/helm$/)
  await expect(page.getByText(`Release ${RELEASE} uninstalled`)).toBeVisible()
  expect((await kubeApi(cluster, "GET", `/api/v1/namespaces/${LIVE_NS}/configmaps/${RELEASE}-config`)).status).toBe(404)
  const records = await kubeApi(cluster, "GET", `/api/v1/namespaces/${LIVE_NS}/secrets?labelSelector=owner%3Dhelm`)
  expect(JSON.parse(records.body).items).toHaveLength(0)
  await page.goto("/kubernetes/helm")
  await expect(page.getByText("No Helm releases.")).toBeVisible()
})

test("a standard user with a read-only token can look but not change", async ({ page, browser }) => {
  test.setTimeout(180_000)
  // A service account that may only read the default namespace.
  await kubeApi(cluster, "POST", "/api/v1/namespaces/default/serviceaccounts", { metadata: { name: VIEWER_SA } })
  await kubeApi(cluster, "POST", "/apis/rbac.authorization.k8s.io/v1/namespaces/default/rolebindings", {
    metadata: { name: VIEWER_SA },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "view" },
    subjects: [{ kind: "ServiceAccount", name: VIEWER_SA, namespace: "default" }],
  })
  const tr = await kubeApi(cluster, "POST", `/api/v1/namespaces/default/serviceaccounts/${VIEWER_SA}/token`, {
    apiVersion: "authentication.k8s.io/v1",
    kind: "TokenRequest",
    spec: { expirationSeconds: 3600 },
  })
  const token = JSON.parse(tr.body).status.token as string

  await signIn(page)
  await page.goto("/users")
  await page.getByRole("button", { name: "Add user" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Username").fill(VIEWER.username)
  await dialog.getByLabel("Password").fill(VIEWER.password)
  await dialog.getByRole("button", { name: "Create" }).click()
  await expect(dialog).toBeHidden()

  await page.goto("/environments")
  await page.getByRole("button", { name: "Add environment" }).click()
  await dialog.getByLabel("Name", { exact: true }).fill(VIEWER_ENV)
  await dialog.getByRole("combobox", { name: "Connection" }).click()
  await page.getByRole("option", { name: "Kubernetes (API server)" }).click()
  await dialog.getByLabel("API server URL").fill(cluster.server)
  await dialog.getByLabel("Bearer token").fill(token)
  await dialog.getByLabel("CA certificate", { exact: true }).fill(cluster.ca)
  await dialog.getByLabel("Default namespace").fill("default")
  await dialog.getByRole("button", { name: "Connect" }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  const row = page.getByRole("row", { name: new RegExp(VIEWER_ENV) })
  await row.getByRole("button", { name: "Manage access" }).click()
  await dialog.getByRole("checkbox", { name: VIEWER.username }).check()
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden()

  const context = await browser.newContext()
  const viewer = await context.newPage()
  await viewer.goto("/login")
  await viewer.getByLabel("Username").fill(VIEWER.username)
  await viewer.getByLabel("Password").fill(VIEWER.password)
  await viewer.getByRole("button", { name: "Login" }).click()
  await expect(viewer).toHaveURL(/\/dashboard$/)
  // The only environment granted is the cluster.
  await expect(viewer.getByTestId("wrong-environment-kind")).toBeVisible()
  await viewer.goto("/kubernetes")
  // Nodes are cluster-wide: forbidden for this account, the rest of the page still works.
  await expect(viewer.getByTestId("card-nodes")).toContainText("forbidden")
  await expect(viewer.getByTestId("card-pods")).toContainText("Pods in default")
  await expect(viewer.getByRole("combobox", { name: "Namespace" })).toHaveText("default")

  await viewer.goto("/kubernetes/namespaces")
  await expect(viewer.getByTestId("kube-error")).toContainText("forbidden")
  await expect(viewer.getByRole("button", { name: "Create namespace" })).toHaveCount(0)
  await viewer.goto("/kubernetes/apply")
  await expect(viewer.getByText("Only administrators can apply manifests.")).toBeVisible()
  await context.close()

  await page.goto("/environments")
  await page.getByRole("row", { name: new RegExp(VIEWER_ENV) }).getByRole("button", { name: "Remove environment" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await expect(page.getByRole("row", { name: new RegExp(VIEWER_ENV) })).toHaveCount(0)
  await page.goto("/users")
  await page.getByRole("row", { name: new RegExp(VIEWER.username) }).getByRole("button", { name: "Delete user" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByRole("row", { name: new RegExp(VIEWER.username) })).toHaveCount(0)
})

test("remove the cluster environment", async ({ page }) => {
  await signIn(page)
  // Back to the Docker environment so the remaining suites run against it.
  await switchEnvironment(page, "local")
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.goto("/environments")
  const row = page.getByRole("row", { name: new RegExp(ENV) })
  await row.getByRole("button", { name: "Remove environment" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await expect(row).toHaveCount(0)
})
