import { execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import https from "node:https"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"
import { parse } from "yaml"

import { ADMIN } from "./credentials"

// Helm install/upgrade/rollback/uninstall, "Edit YAML" and live ConfigMaps.
// Runs after the "login" project, which creates the ADMIN account.
//
// Needs a THROWAWAY cluster (like kubernetes.spec.ts) plus `helm` and
// `kubectl` on the PATH; nothing is downloaded from the internet: the chart
// repository is served from 127.0.0.1 by this file and the workload runs
// alpine:3 (load it into the cluster first):
//   kind create cluster --name gantry-k8s-e2e --kubeconfig /tmp/gantry-k8s-e2e.kubeconfig
//   kind load docker-image alpine:3 --name gantry-k8s-e2e
//   GANTRY_E2E_KUBECONFIG=/tmp/gantry-k8s-e2e.kubeconfig pnpm test:e2e tests/e2e/login.spec.ts tests/e2e/kubernetes-helm-edit.spec.ts
// helm and kubectl only ever get that kubeconfig and private helm directories.
test.describe.configure({ mode: "serial" })

const KUBECONFIG = process.env.GANTRY_E2E_KUBECONFIG
const ENV = "gantry-test-ke-kind"
const stamp = Date.now().toString(36)
/** ConfigMaps (live list and editing). */
const NS = `gantry-test-ke-${stamp}`
/** Created by helm install --create-namespace. */
const HELM_NS = `gantry-test-ke-helm-${stamp}`
const REPO = "gantry-e2e"
const CHART = "gantry-e2e-app"
const RELEASE = "gantry-e2e-web"
const CM = "gantry-e2e-live"

type Cluster = { server: string; ca: string; cert: string; key: string }

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

/** Direct API call for setup, checks and cleanup (not through Gantry). */
function kubeApi(cluster: Cluster, method: string, apiPath: string, body?: unknown): Promise<{ status: number; body: string }> {
  const url = new URL(cluster.server)
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: apiPath,
        ca: cluster.ca,
        cert: cluster.cert,
        key: cluster.key,
        headers: payload ? { "Content-Type": "application/json" } : {},
      },
      (res) => {
        let text = ""
        res.on("data", (c) => (text += c))
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }))
      }
    )
    req.on("error", reject)
    req.end(payload)
  })
}

async function configMapData(cluster: Cluster, ns: string, name: string): Promise<Record<string, string> | null> {
  const res = await kubeApi(cluster, "GET", `/api/v1/namespaces/${ns}/configmaps/${name}`)
  return res.status === 200 ? (JSON.parse(res.body).data ?? {}) : null
}

function hasCommand(cmd: string, args: string[]) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** kubectl apply with the test kubeconfig only (through sh and a file: snap kubectl dislikes Node's pipes). */
function kubectlApply(manifest: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-ke-kubectl-"))
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

// ------------------------------------------------------- local chart repository

const CHART_TEMPLATES = {
  "configmap.yaml": `apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-config
data:
  greeting: {{ .Values.greeting | quote }}
  chartVersion: {{ .Chart.Version | quote }}
`,
  "deployment.yaml": `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}
spec:
  replicas: 1
  selector:
    matchLabels: { app: {{ .Release.Name }} }
  template:
    metadata:
      labels: { app: {{ .Release.Name }} }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: main
          image: alpine:3
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "sleep 3600"]
`,
  "NOTES.txt": "The greeting is {{ .Values.greeting }}.\n",
}

let repoDir = ""
let repoServer: http.Server | undefined
let repoUrl = ""

/** Packages two versions of a tiny chart, indexes them and serves the directory on 127.0.0.1. */
async function startChartRepo() {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-ke-charts-"))
  const helmEnv = {
    ...process.env,
    KUBECONFIG: "",
    HELM_CACHE_HOME: path.join(repoDir, ".cache"),
    HELM_CONFIG_HOME: path.join(repoDir, ".config"),
    HELM_DATA_HOME: path.join(repoDir, ".data"),
  }
  const out = path.join(repoDir, "repo")
  fs.mkdirSync(out)
  for (const version of ["0.1.0", "0.2.0"]) {
    const src = path.join(repoDir, `src-${version}`, CHART)
    fs.mkdirSync(path.join(src, "templates"), { recursive: true })
    fs.writeFileSync(path.join(src, "Chart.yaml"), `apiVersion: v2\nname: ${CHART}\nversion: ${version}\nappVersion: "${version}"\ndescription: Gantry e2e chart\n`)
    fs.writeFileSync(path.join(src, "values.yaml"), "# Shown in the values editor.\ngreeting: hello\n")
    for (const [file, text] of Object.entries(CHART_TEMPLATES)) fs.writeFileSync(path.join(src, "templates", file), text)
    execFileSync("helm", ["package", src, "--destination", out], { env: helmEnv, stdio: "pipe" })
  }
  repoServer = http.createServer((req, res) => {
    const file = path.join(out, path.basename(decodeURIComponent((req.url ?? "/").split("?")[0])))
    if (!file.startsWith(out) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { "Content-Type": file.endsWith(".yaml") ? "text/yaml" : "application/gzip" })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise<void>((resolve) => repoServer!.listen(0, "127.0.0.1", resolve))
  repoUrl = `http://127.0.0.1:${(repoServer.address() as AddressInfo).port}`
  execFileSync("helm", ["repo", "index", out, "--url", repoUrl], { env: helmEnv, stdio: "pipe" })
}

// -------------------------------------------------------------------- helpers

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

async function pick(page: Page, scope: ReturnType<Page["getByRole"]> | Page, label: string, option: string) {
  await scope.getByRole("combobox", { name: label }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

let cluster: Cluster

test.beforeAll(async () => {
  test.skip(!KUBECONFIG, "GANTRY_E2E_KUBECONFIG not set (needs a throwaway cluster)")
  test.skip(!hasCommand("helm", ["version", "--short"]), "helm is not installed")
  test.skip(!hasCommand("kubectl", ["version", "--client"]), "kubectl is not installed")
  cluster = readCluster()
  const version = await kubeApi(cluster, "GET", "/version").catch(() => null)
  test.skip(version?.status !== 200, "the test cluster is not reachable")
  await startChartRepo()
})

test.afterAll(async () => {
  repoServer?.close()
  if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true })
  if (!cluster) return
  await kubeApi(cluster, "DELETE", `/api/v1/namespaces/${NS}`).catch(() => {})
  await kubeApi(cluster, "DELETE", `/api/v1/namespaces/${HELM_NS}`).catch(() => {})
})

// ---------------------------------------------------------------------- tests

test("add the cluster", async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page)
  await page.goto("/environments")
  await page.getByRole("button", { name: "Add environment" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name", { exact: true }).fill(ENV)
  await dialog.getByRole("combobox", { name: "Connection" }).click()
  await page.getByRole("option", { name: "Kubernetes (API server)" }).click()
  await dialog.getByRole("radio", { name: "Kubeconfig" }).click()
  await dialog.getByLabel("Kubeconfig", { exact: true }).fill(fs.readFileSync(KUBECONFIG!, "utf8"))
  await dialog.getByRole("button", { name: "Connect" }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(page.getByRole("row", { name: new RegExp(ENV) })).toContainText("up · Kubernetes v1.")
})

test("the ConfigMaps page updates live when kubectl creates one", async ({ page }) => {
  test.setTimeout(120_000)
  expect((await kubeApi(cluster, "POST", "/api/v1/namespaces", { metadata: { name: NS } })).status).toBe(201)
  await signInToCluster(page)
  await page.goto("/kubernetes/config")
  await pickNamespace(page, NS)
  // Every namespace has kube-root-ca.crt; ours isn't there yet.
  await expect(page.getByRole("row", { name: /kube-root-ca\.crt/ })).toBeVisible()
  await expect(page.getByRole("row", { name: new RegExp(CM) })).toHaveCount(0)
  await expect(page.getByTestId("live-indicator")).toHaveAttribute("data-status", "connected")

  kubectlApply(`apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${CM}\n  namespace: ${NS}\ndata:\n  color: blue\n`)
  // No reload: the watch refreshes the page.
  await expect(page.getByRole("row", { name: new RegExp(CM) })).toContainText("color", { timeout: 30_000 })
})

test("edit a ConfigMap as YAML: review the diff, apply, and a conflict is reported", async ({ page }) => {
  test.setTimeout(180_000)
  await signInToCluster(page)
  await page.goto("/kubernetes/config")
  await pickNamespace(page, NS)
  await page.getByRole("row", { name: new RegExp(CM) }).getByRole("link", { name: "Edit YAML" }).click()
  await expect(page).toHaveURL(new RegExp(`/kubernetes/edit/configmaps/${NS}/${CM}$`))
  await expect(page.getByRole("heading", { name: `Edit ConfigMap ${CM}` })).toBeVisible()

  const editor = page.getByRole("textbox", { name: "YAML" })
  await expect(editor).toHaveValue(/color: blue/)
  // Server bookkeeping is left out of the editor.
  expect(await editor.inputValue()).not.toContain("managedFields")
  expect(await editor.inputValue()).not.toContain("resourceVersion")

  // Apply stays off until the change was reviewed.
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeDisabled()
  await editor.fill((await editor.inputValue()).replace("color: blue", "color: green\n  size: large"))
  await page.getByRole("button", { name: "Review changes" }).click()
  const diff = page.getByTestId("yaml-diff")
  await expect(diff).toContainText("color: blue")
  await expect(diff.locator('[data-diff="remove"]')).toHaveCount(1)
  await expect(diff.locator('[data-diff="remove"]')).toContainText("color: blue")
  await expect(diff.locator('[data-diff="add"]')).toHaveCount(2)
  await expect(diff.locator('[data-diff="add"]').first()).toContainText("color: green")
  await expect(page.getByText("2 line(s) added, 1 removed")).toBeVisible()
  // The review was a dry run: nothing changed yet.
  expect((await configMapData(cluster, NS, CM))?.color).toBe("blue")

  // Changing the text after the review needs another review.
  await editor.fill((await editor.inputValue()) + " ")
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeDisabled()
  await editor.fill((await editor.inputValue()).trimEnd() + "\n")
  await page.getByRole("button", { name: "Review changes" }).click()
  await expect(page.getByRole("button", { name: "Apply changes" })).toBeEnabled()
  await page.getByRole("button", { name: "Apply changes" }).click()
  await expect(page.getByText(`ConfigMap ${CM} updated`)).toBeVisible()
  await expect.poll(async () => (await configMapData(cluster, NS, CM))?.size).toBe("large")
  expect((await configMapData(cluster, NS, CM))?.color).toBe("green")

  // The editor restarts at the new version. Edit, review, then someone else changes the object...
  await expect(editor).toHaveValue(/color: green/)
  await editor.fill((await editor.inputValue()).replace("color: green", "color: mine"))
  await page.getByRole("button", { name: "Review changes" }).click()
  await expect(page.getByTestId("yaml-diff")).toContainText("color: mine")
  kubectlApply(`apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${CM}\n  namespace: ${NS}\ndata:\n  color: theirs\n`)
  // ...so applying is refused instead of overwriting their change.
  await page.getByRole("button", { name: "Apply changes" }).click()
  const conflict = page.getByTestId("edit-conflict")
  await expect(conflict).toContainText("Conflict: the object changed")
  await expect(conflict).toContainText("Someone changed this object since you opened it")
  expect((await configMapData(cluster, NS, CM))?.color).toBe("theirs")
  // Reviewing again reports the conflict too.
  await page.getByRole("button", { name: "Review changes" }).click()
  await expect(conflict).toBeVisible()
  await conflict.getByRole("button", { name: "Load latest version" }).click()
  await expect(editor).toHaveValue(/color: theirs/)
  await expect(conflict).toBeHidden()

  // Renaming is refused.
  await editor.fill((await editor.inputValue()).replace(`name: ${CM}`, "name: other"))
  await page.getByRole("button", { name: "Review changes" }).click()
  await expect(page.getByTestId("edit-error")).toContainText(`metadata.name must stay ${CM}`)
})

test("add a chart repository", async ({ page }) => {
  await signInToCluster(page)
  await page.goto("/kubernetes/helm")
  await page.getByRole("link", { name: "Chart repositories" }).click()
  await expect(page).toHaveURL(/\/kubernetes\/charts\/repositories$/)
  await page.getByRole("button", { name: "Add repository" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name", { exact: true }).fill(REPO)
  await dialog.getByLabel("URL", { exact: true }).fill(`${repoUrl}/`)
  await dialog.getByRole("button", { name: "Add" }).click()
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(page.getByRole("row", { name: new RegExp(REPO) })).toContainText(repoUrl)

  // A URL without a chart index is refused.
  await page.getByRole("button", { name: "Add repository" }).click()
  await dialog.getByLabel("Name", { exact: true }).fill("gantry-e2e-broken")
  await dialog.getByLabel("URL", { exact: true }).fill(`${repoUrl}/nothing-here`)
  await dialog.getByRole("button", { name: "Add" }).click()
  await expect(dialog.getByText(/Downloading the index of gantry-e2e-broken failed/)).toBeVisible({ timeout: 30_000 })
  await dialog.getByRole("button", { name: "Cancel" }).click()
})

test("install a chart with edited values, upgrade, roll back and uninstall", async ({ page }) => {
  test.setTimeout(420_000)
  await signInToCluster(page)
  await page.goto("/kubernetes/helm")
  await page.getByRole("link", { name: "Install chart" }).click()
  await expect(page).toHaveURL(/\/kubernetes\/charts$/)

  // Pick the chart and an older version; the editor fills with its defaults.
  const form = page.getByRole("form", { name: "Install chart" })
  await expect(form.getByRole("combobox", { name: "Repository" })).toHaveText(REPO)
  await form.getByLabel("Chart", { exact: true }).fill(CHART)
  await expect(form.getByRole("combobox", { name: "Version" })).toContainText("0.2.0")
  await pick(page, form, "Version", "0.1.0 (app 0.1.0)")
  const values = form.getByRole("textbox", { name: "Values" })
  await expect(values).toHaveValue(/greeting: hello/, { timeout: 30_000 })
  await values.fill("greeting: from-install\n")
  await form.getByLabel("Release name").fill(RELEASE)
  await form.getByLabel("Namespace", { exact: true }).fill(HELM_NS)
  await form.getByRole("button", { name: "Install" }).click()

  // Live output, then success.
  const op = page.getByTestId("helm-operation")
  await expect(op.getByTestId("helm-output")).toContainText(`$ helm install ${RELEASE} ${REPO}/${CHART}`)
  await expect(op).toHaveAttribute("data-state", "succeeded", { timeout: 240_000 })
  await expect(op.getByTestId("helm-output")).toContainText("STATUS: deployed")
  await expect(op.getByTestId("helm-output")).toContainText("The greeting is from-install.")
  // No credentials in what the browser got.
  expect(await page.content()).not.toContain(cluster.key.split("\n")[1])
  expect(await configMapData(cluster, HELM_NS, `${RELEASE}-config`)).toEqual({ greeting: "from-install", chartVersion: "0.1.0" })

  // The release page: history, upgrade with values prefilled from the release.
  await page.getByRole("link", { name: `Open release ${RELEASE}` }).click()
  await expect(page).toHaveURL(new RegExp(`/kubernetes/helm/${HELM_NS}/${RELEASE}$`))
  await expect(page.getByTestId("helm-history")).toContainText(`${CHART}-0.1.0`)
  const upgrade = page.getByRole("form", { name: "Upgrade release" })
  await expect(upgrade.getByLabel("Chart", { exact: true })).toHaveValue(CHART)
  await expect(upgrade.getByRole("combobox", { name: "Version" })).toContainText("0.2.0")
  const upgradeValues = upgrade.getByRole("textbox", { name: "Values" })
  await expect(upgradeValues).toHaveValue(/greeting: from-install/)
  await upgradeValues.fill("greeting: from-upgrade\n")
  await upgrade.getByRole("button", { name: "Upgrade" }).click()
  const upgradeOp = page.getByTestId("helm-operation").first()
  await expect(upgradeOp).toHaveAttribute("data-state", "succeeded", { timeout: 240_000 })
  await expect(upgradeOp.getByTestId("helm-output")).toContainText(`$ helm upgrade ${RELEASE} ${REPO}/${CHART}`)
  expect(await configMapData(cluster, HELM_NS, `${RELEASE}-config`)).toEqual({ greeting: "from-upgrade", chartVersion: "0.2.0" })
  await expect(page.getByTestId("helm-history")).toContainText(`${CHART}-0.2.0`)
  await expect(page.getByTestId("helm-values")).toContainText("greeting: from-upgrade")

  // Roll back to revision 1: a new revision 3 with the first chart and values.
  const rollback = page.getByRole("form", { name: "Roll back release" })
  await pick(page, rollback, "Revision", `1: ${CHART}-0.1.0 (superseded)`)
  await rollback.getByRole("button", { name: "Roll back" }).click()
  const rollbackOp = page.getByTestId("helm-operation").last()
  await expect(rollbackOp).toHaveAttribute("data-state", "succeeded", { timeout: 240_000 })
  await expect(rollbackOp).toContainText(`Release ${RELEASE} rolled back to revision 1`)
  expect(await configMapData(cluster, HELM_NS, `${RELEASE}-config`)).toEqual({ greeting: "from-install", chartVersion: "0.1.0" })
  await expect(page.getByTestId("helm-history").getByRole("row", { name: /^3/ })).toContainText("deployed")

  // Uninstall behind a confirmation.
  await page.getByRole("button", { name: "Uninstall" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Uninstall" }).click()
  await expect(page).toHaveURL(/\/kubernetes\/helm$/)
  await expect(page.getByText(`Release ${RELEASE} uninstalled`)).toBeVisible({ timeout: 60_000 })
  expect(await configMapData(cluster, HELM_NS, `${RELEASE}-config`)).toBeNull()
  const records = await kubeApi(cluster, "GET", `/api/v1/namespaces/${HELM_NS}/secrets?labelSelector=owner%3Dhelm`)
  expect(JSON.parse(records.body).items).toHaveLength(0)

  await page.goto("/activity")
  for (const action of ["kubernetes.helm.repo.add", "kubernetes.helm.install", "kubernetes.helm.upgrade", "kubernetes.helm.rollback", "kubernetes.helm.uninstall", "kubernetes.edit"]) {
    await expect(page.getByRole("cell", { name: action, exact: true }).first()).toBeVisible()
  }
})

test("remove the repository and the cluster environment", async ({ page }) => {
  await signIn(page)
  await page.goto("/kubernetes/charts/repositories")
  await page.getByRole("button", { name: `Remove ${REPO}` }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await expect(page.getByRole("row", { name: new RegExp(REPO) })).toHaveCount(0)

  await switchEnvironment(page, "local")
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.goto("/environments")
  const row = page.getByRole("row", { name: new RegExp(ENV) })
  await row.getByRole("button", { name: "Remove environment" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await expect(row).toHaveCount(0)
})
