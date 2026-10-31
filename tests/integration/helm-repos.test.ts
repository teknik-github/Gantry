import { execFileSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { openTestDb } from "../helpers/test-db"

// Chart repositories against the real helm CLI and a chart repository served
// from 127.0.0.1 (with and without basic auth). No cluster, no internet.
// Skipped when helm is not installed.

const current = vi.hoisted(() => ({ db: null as unknown }))
vi.mock("@/lib/server/db", () => ({ getDb: async () => current.db }))

const { insertHelmRepo, getHelmRepo, listHelmRepos } = await import("@/lib/server/kubernetes/helm-repos")
const { checkRepository, listChartVersions, listRepoCharts, showChartValues } = await import("@/lib/server/kubernetes/helm-operations")
const { helmHome } = await import("@/lib/server/kubernetes/helm-cli")

const hasHelm = (() => {
  try {
    execFileSync(process.env.HELM_BIN || "helm", ["version", "--short"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const PASSWORD = "s3cret-chart-pass"

describe.skipIf(!hasHelm)("chart repositories with the helm CLI", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>
  let dir = ""
  let server: http.Server
  let base = ""

  beforeAll(async () => {
    t = await openTestDb()
    current.db = t.db
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-k-helmrepo-"))
    const env = { ...process.env, KUBECONFIG: "", HELM_CACHE_HOME: path.join(dir, "c"), HELM_CONFIG_HOME: path.join(dir, "f"), HELM_DATA_HOME: path.join(dir, "d") }
    const out = path.join(dir, "repo")
    fs.mkdirSync(out)
    for (const version of ["1.0.0", "1.1.0"]) {
      const src = path.join(dir, `src-${version}`, "demo")
      fs.mkdirSync(path.join(src, "templates"), { recursive: true })
      fs.writeFileSync(path.join(src, "Chart.yaml"), `apiVersion: v2\nname: demo\nversion: ${version}\nappVersion: "${version}"\ndescription: Demo chart\n`)
      fs.writeFileSync(path.join(src, "values.yaml"), `# defaults of ${version}\nreplicas: 1\n`)
      fs.writeFileSync(path.join(src, "templates", "cm.yaml"), "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n")
      execFileSync("helm", ["package", src, "--destination", out], { env, stdio: "pipe" })
    }
    server = http.createServer((req, res) => {
      const [, scope, file] = (req.url ?? "").split("/")
      // /open/* is public, /private/* needs basic auth.
      if (scope === "private" && req.headers.authorization !== `Basic ${Buffer.from(`bob:${PASSWORD}`).toString("base64")}`) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="charts"' }).end()
        return
      }
      const p = path.join(out, path.basename(file ?? ""))
      if (!["open", "private"].includes(scope) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
        res.writeHead(404).end()
        return
      }
      fs.createReadStream(p).pipe(res.writeHead(200))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    // Absolute chart URLs are fine for both scopes: helm sends the repository's credentials to the same host.
    execFileSync("helm", ["repo", "index", out, "--url", `${base}/open`], { env, stdio: "pipe" })
  })

  afterAll(async () => {
    server?.close()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    await t?.cleanup()
  })

  it("checks, lists charts and versions, and shows default values", async () => {
    await checkRepository({ name: "open", url: `${base}/open`, credentials: null, oci: false })
    const id = await insertHelmRepo({ name: "open", url: `${base}/open`, credentials: null })
    expect(await listRepoCharts(id)).toEqual([{ name: "demo", version: "1.1.0", appVersion: "1.1.0", description: "Demo chart" }])
    expect((await listChartVersions(id, "demo")).map((v) => v.version)).toEqual(["1.1.0", "1.0.0"])
    expect(await listChartVersions(id, "missing")).toEqual([])
    expect(await showChartValues({ type: "repo", repoId: id, chart: "demo" }, "1.0.0")).toContain("# defaults of 1.0.0")
    // The index is cached under DATA_DIR; nothing is registered in helm's own config.
    expect(fs.existsSync(path.join(helmHome().repositoryCache, "open-index.yaml"))).toBe(true)
    expect(fs.existsSync(path.join(helmHome().config, "repositories.yaml"))).toBe(false)
  })

  it("uses stored credentials, keeps them encrypted and out of error messages", async () => {
    const repo = { name: "private", url: `${base}/private`, oci: false }
    const denied = checkRepository({ ...repo, credentials: { username: "bob", password: "wrong-password-1" } })
    await expect(denied).rejects.toThrow(/Downloading the index of private failed/)
    await denied.catch((err: Error) => expect(err.message).not.toContain("wrong-password-1"))

    await checkRepository({ ...repo, credentials: { username: "bob", password: PASSWORD } })
    const id = await insertHelmRepo({ ...repo, credentials: { username: "bob", password: PASSWORD } })
    const row = await t.db.selectFrom("helm_repositories").selectAll().where("id", "=", id).executeTakeFirstOrThrow()
    expect(row.credentials).toMatch(/^v1\./)
    expect(JSON.stringify(row)).not.toContain(PASSWORD)
    expect((await getHelmRepo(id))?.credentials).toEqual({ username: "bob", password: PASSWORD })
    expect((await listHelmRepos()).find((r) => r.id === id)).toMatchObject({ name: "private", username: "bob" })
    expect(JSON.stringify(await listHelmRepos())).not.toContain(PASSWORD)
    expect((await listChartVersions(id, "demo")).map((v) => v.version)).toEqual(["1.1.0", "1.0.0"])
  })

  it("reports a URL without an index", async () => {
    await expect(checkRepository({ name: "nothing", url: `${base}/none`, credentials: null, oci: false })).rejects.toThrow(
      /Downloading the index of nothing failed/
    )
  })
})
