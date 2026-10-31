import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { createRepo, startGitServer, type GitServer } from "../helpers/git-http-server"
import { ADMIN } from "./credentials"
import { docker, dockerAvailable } from "./docker"

// Image build, tag and push end to end against the host's Docker: builds
// from the editor (live log, build arg), a failing build, cancelling a
// running build (its RUN container must stop), a build from a Git
// repository served over http on 127.0.0.1, and tag + push to a throwaway
// registry:2 with htpasswd, then a build that pulls its private base image
// and pushes after building. Everything created is named gantry-test-b-*
// and removed by name afterwards.
test.describe.configure({ mode: "serial" })

const RUN = Date.now().toString(36)
const EDITOR_TAG = `gantry-test-b-editor:${RUN}`
const FAIL_TAG = `gantry-test-b-fail:${RUN}`
const CANCEL_TAG = `gantry-test-b-cancel:${RUN}`
const GIT_TAG = `gantry-test-b-git:${RUN}`
const UPLOAD_TAG = `gantry-test-b-upload:${RUN}`
const GREETING = `greeting-${crypto.randomBytes(4).toString("hex")}`
const CANCEL_MARKER = `gantry-test-b-cancel-${crypto.randomBytes(4).toString("hex")}`

const PORT = 16000 + Math.floor(Math.random() * 1000)
const HOST = `localhost:${PORT}`
const REPO = `${HOST}/gantry-test-b/app`
const REGISTRY = `gantry-test-b-registry-${RUN}`
const REG_USER = "gantry-b"
const REG_PASSWORD = `e2e-b-pass-${crypto.randomBytes(4).toString("hex")}`

const GIT_USER = "gantry-b"
const GIT_TOKEN = `e2e-b-git-token-${crypto.randomBytes(8).toString("hex")}`

// Builds start containers; this host can be slow.
const BUILD_TIMEOUT = 240_000
const TIMEOUT = 600_000

let tmp = ""
let server: GitServer | undefined
let repo: Awaited<ReturnType<typeof createRepo>> | undefined

function cli(...args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, DOCKER_CONFIG: path.join(tmp, "cli") },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

/** Untags every image named like this suite's (by tag, never by id: alpine:3 shares layers). */
async function removeTestImages() {
  const images = await docker<{ Id: string; RepoTags: string[] | null }[]>("GET", "/images/json").catch(() => [])
  for (const img of images) {
    for (const tag of img.RepoTags ?? []) {
      if (tag.startsWith("gantry-test-b-") || tag.startsWith(`${HOST}/`)) {
        await docker("DELETE", `/images/${encodeURIComponent(tag)}`).catch(() => {})
      }
    }
  }
}

/** Registry API with the test login (catalog, tags). */
async function registryGet<T>(apiPath: string): Promise<T> {
  const res = await fetch(`http://${HOST}${apiPath}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${REG_USER}:${REG_PASSWORD}`).toString("base64")}` },
  })
  if (!res.ok) throw new Error(`${apiPath}: ${res.status}`)
  return (await res.json()) as T
}

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

/** The build page with the editor tab, a Dockerfile and options filled in. */
async function fillEditorBuild(page: Page, opts: { dockerfile: string; tags: string; buildArgs?: string }) {
  await openBuildPage(page)
  await page.getByRole("textbox", { name: "Dockerfile", exact: true }).fill(opts.dockerfile)
  await page.getByLabel("Tags").fill(opts.tags)
  if (opts.buildArgs) await page.getByLabel("Build arguments").fill(opts.buildArgs)
}

/** The build page, once hydrated (the Build button is disabled until then). */
async function openBuildPage(page: Page) {
  await page.goto("/images/build")
  await expect(page.getByRole("button", { name: "Build image" })).toBeEnabled({ timeout: 60_000 })
}

/** Searches the Images table until the row shows (the search box only filters once hydrated). */
async function findImageRow(page: Page, name: string) {
  await page.goto("/images")
  const search = page.getByRole("textbox", { name: "Search" })
  const row = page.getByRole("row").filter({ hasText: name })
  await expect(async () => {
    await search.fill("")
    await search.fill(name)
    await expect(row).toHaveCount(1, { timeout: 3_000 })
  }).toPass({ timeout: 90_000 })
  return row
}

const buildLog = (page: Page) => page.getByRole("log", { name: "Build log" })
const result = (page: Page) => page.getByTestId("stream-result")

test.beforeAll(async () => {
  test.setTimeout(TIMEOUT)
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-b-e2e-"))
  fs.mkdirSync(path.join(tmp, "cli"))
  fs.mkdirSync(path.join(tmp, "auth"))
  await removeTestImages()

  const hash = cli("run", "--rm", "caddy:2-alpine", "caddy", "hash-password", "--plaintext", REG_PASSWORD)
  fs.writeFileSync(path.join(tmp, "auth", "htpasswd"), `${REG_USER}:${hash}\n`)
  cli(
    "run", "-d", "--name", REGISTRY, "--label", "gantry.e2e=true",
    "-p", `127.0.0.1:${PORT}:5000`,
    "-v", `${path.join(tmp, "auth")}:/auth:ro`,
    "-e", "REGISTRY_AUTH=htpasswd",
    "-e", "REGISTRY_AUTH_HTPASSWD_REALM=gantry-test-b",
    "-e", "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
    "registry:2"
  )
  for (let i = 0; ; i++) {
    try {
      await registryGet("/v2/")
      break
    } catch (err) {
      if (i > 40) throw err
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  // A build context above the 10 MB Next buffers for requests through proxy.ts.
  const ctx = path.join(tmp, "upload-ctx")
  fs.mkdirSync(path.join(ctx, "docker"), { recursive: true })
  fs.writeFileSync(path.join(ctx, "big.bin"), crypto.randomBytes(12 * 1024 * 1024))
  fs.writeFileSync(path.join(ctx, "docker", "Dockerfile.upload"), "FROM alpine:3\nCOPY big.bin /big.bin\nRUN wc -c /big.bin\n")
  execFileSync("tar", ["-czf", path.join(tmp, "gantry-test-b-context.tar.gz"), "-C", ctx, "."])

  server = await startGitServer({ auth: { username: GIT_USER, password: GIT_TOKEN } })
  repo = await createRepo(server, "gantry-test-b-app")
  await repo.commit(
    {
      "app/Dockerfile": "FROM alpine:3\nCOPY hello.txt /hello.txt\nRUN cat /hello.txt\n",
      "app/hello.txt": `hello from git ${RUN}\n`,
      "README.md": "not part of the context\n",
    },
    "App"
  )
})

test.afterAll(async () => {
  test.setTimeout(TIMEOUT)
  await server?.close()
  await repo?.remove()
  if (!(await dockerAvailable())) return
  await docker("DELETE", `/containers/${REGISTRY}?force=true&v=true`).catch(() => {})
  await removeTestImages()
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

test("builds from the editor with a build arg, streaming the log", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page)
  await page.goto("/images")
  await page.getByRole("link", { name: "Build image" }).click()
  await expect(page).toHaveURL(/\/images\/build$/)

  await fillEditorBuild(page, {
    dockerfile: 'FROM alpine:3\nARG GREETING=hello\nRUN echo "gantry-test-b says $GREETING"\n',
    tags: EDITOR_TAG,
    buildArgs: `GREETING=${GREETING}`,
  })
  await page.getByRole("button", { name: "Build image" }).click()

  // Output arrives while the build runs.
  await expect(page.getByRole("button", { name: "Cancel build" })).toBeVisible()
  await expect(buildLog(page)).toContainText("Step 1/3 : FROM alpine:3", { timeout: BUILD_TIMEOUT })
  await expect(buildLog(page)).toContainText(`gantry-test-b says ${GREETING}`, { timeout: BUILD_TIMEOUT })
  await expect(result(page)).toContainText("Build succeeded", { timeout: BUILD_TIMEOUT })
  await expect(result(page)).toContainText(EDITOR_TAG)
  const imageId = (await page.getByTestId("built-image-id").textContent()) ?? ""
  expect(imageId).toMatch(/^sha256:[a-f0-9]{64}$/)

  const inspect = await docker<{ Id: string; RepoTags: string[] }>("GET", `/images/${encodeURIComponent(EDITOR_TAG)}/json`)
  expect(inspect.RepoTags).toContain(EDITOR_TAG)

  // Listed in the history; its stored log has the output.
  const row = page.getByRole("table", { name: "Recent builds" }).getByRole("row").filter({ hasText: EDITOR_TAG })
  await expect(row).toContainText("success")
  await row.getByRole("button", { name: /^Log of build/ }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("log")).toContainText(`gantry-test-b says ${GREETING}`)
  await expect(dialog).toContainText(imageId)
  await page.keyboard.press("Escape")
})

test("a failing build shows Docker's error", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page)
  await fillEditorBuild(page, { dockerfile: "FROM alpine:3\nRUN echo about to fail && exit 3\n", tags: FAIL_TAG })
  await page.getByRole("button", { name: "Build image" }).click()
  const alert = result(page)
  await expect(alert).toContainText("Build failed", { timeout: BUILD_TIMEOUT })
  await expect(alert).toContainText("returned a non-zero code: 3")
  await expect(buildLog(page)).toContainText("about to fail")
  await expect(page.getByRole("table", { name: "Recent builds" }).getByRole("row").filter({ hasText: FAIL_TAG })).toContainText("error")

  // Invalid options never reach Docker.
  await page.getByLabel("Tags").fill("Not:Valid:Tag")
  await page.getByRole("button", { name: "Build image" }).click()
  await expect(page.getByText(/Repository names must be lowercase|not a valid/).first()).toBeVisible()
})

test("cancelling a build stops it in Docker", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page)
  await fillEditorBuild(page, { dockerfile: `FROM alpine:3\nRUN echo ${CANCEL_MARKER} && sleep 600\n`, tags: CANCEL_TAG })
  await page.getByRole("button", { name: "Build image" }).click()
  // The RUN step's container printed the marker: it is running now.
  await expect(buildLog(page)).toContainText(`${CANCEL_MARKER}\n`, { timeout: BUILD_TIMEOUT })
  const running = async () => {
    const list = await docker<{ Command: string; State: string }[]>("GET", "/containers/json?all=true")
    return list.filter((c) => c.Command.includes(CANCEL_MARKER) && c.State === "running").length
  }
  expect(await running()).toBe(1)

  await page.getByRole("button", { name: "Cancel build" }).click()
  await expect(result(page)).toContainText("Build cancelled")
  // Closing the request made the daemon kill the step's container.
  await expect.poll(running, { timeout: 120_000, intervals: [1_000, 2_000] }).toBe(0)
  await expect
    .poll(
      async () => {
        await page.reload()
        return (await page.getByRole("table", { name: "Recent builds" }).getByRole("row").filter({ hasText: CANCEL_TAG }).textContent()) ?? ""
      },
      { timeout: 60_000 }
    )
    .toContain("cancelled")
  await expect(docker("GET", `/images/${encodeURIComponent(CANCEL_TAG)}/json`)).rejects.toThrow(/404/)
})

test("builds from a Git repository without keeping its credentials", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page)
  await openBuildPage(page)
  await page.getByRole("tab", { name: "Git repository" }).click()
  await page.getByLabel("Repository URL").fill(server!.url("gantry-test-b-app"))
  await page.getByLabel("Branch, tag or commit").fill("main")
  await page.getByLabel("Context directory").fill("app")
  await page.getByLabel("Username").fill(GIT_USER)
  await page.getByLabel("Access token").fill(GIT_TOKEN)
  await page.getByLabel("Tags").fill(GIT_TAG)
  await page.getByRole("button", { name: "Build image" }).click()

  await expect(buildLog(page)).toContainText("Cloning", { timeout: BUILD_TIMEOUT })
  await expect(buildLog(page)).toContainText(`hello from git ${RUN}`, { timeout: BUILD_TIMEOUT })
  await expect(result(page)).toContainText("Build succeeded", { timeout: BUILD_TIMEOUT })
  expect(server!.authHeaders.length).toBeGreaterThan(0)
  await docker("GET", `/images/${encodeURIComponent(GIT_TAG)}/json`)

  // The token is nowhere in the output, the history or the stored log.
  await page.reload()
  await expect(page.locator("body")).not.toContainText(GIT_TOKEN)
  const row = page.getByRole("table", { name: "Recent builds" }).getByRole("row").filter({ hasText: GIT_TAG })
  await expect(row).toContainText("success")
  await row.getByRole("button", { name: /^Log of build/ }).click()
  await expect(page.getByRole("dialog").getByRole("log")).toContainText(`hello from git ${RUN}`)
  await expect(page.getByRole("dialog")).not.toContainText(GIT_TOKEN)
  await page.keyboard.press("Escape")

  // Rebuild prefills the source and options, not the token.
  await row.getByRole("link", { name: /^Rebuild build/ }).click()
  await expect(page).toHaveURL(/\/images\/build\?from=\d+$/)
  await expect(page.getByLabel("Repository URL")).toHaveValue(server!.url("gantry-test-b-app"))
  await expect(page.getByLabel("Context directory")).toHaveValue("app")
  await expect(page.getByLabel("Access token")).toHaveValue("")
  await expect(page.getByLabel("Tags")).toHaveValue(GIT_TAG)
})

test("builds from an uploaded archive larger than 10 MB", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page)
  await openBuildPage(page)
  await page.getByRole("tab", { name: "Upload archive" }).click()
  await page.getByLabel("Build context archive").setInputFiles(path.join(tmp, "gantry-test-b-context.tar.gz"))
  await page.getByRole("textbox", { name: "Dockerfile path", exact: true }).fill("docker/Dockerfile.upload")
  await page.getByLabel("Tags").fill(UPLOAD_TAG)
  await page.getByRole("button", { name: "Build image" }).click()
  await expect(buildLog(page)).toContainText("Sending the uploaded archive", { timeout: BUILD_TIMEOUT })
  // The whole file arrived: wc prints its full size.
  await expect(buildLog(page)).toContainText(`${12 * 1024 * 1024} /big.bin`, { timeout: BUILD_TIMEOUT })
  await expect(result(page)).toContainText("Build succeeded", { timeout: BUILD_TIMEOUT })
  const row = page.getByRole("table", { name: "Recent builds" }).getByRole("row").filter({ hasText: UPLOAD_TAG })
  await expect(row).toContainText("success")
  // Nothing to rebuild from: the archive isn't kept.
  await expect(row.getByRole("link", { name: /^Rebuild/ })).toHaveCount(0)

  // Not an archive: refused before Docker sees it.
  fs.writeFileSync(path.join(tmp, "gantry-test-b-not.tar"), "plain text, not a tar archive\n".repeat(40))
  await page.getByLabel("Build context archive").setInputFiles(path.join(tmp, "gantry-test-b-not.tar"))
  await page.getByRole("textbox", { name: "Dockerfile path", exact: true }).fill("Dockerfile")
  await page.getByRole("button", { name: "Build image" }).click()
  await expect(result(page)).toContainText("not a tar archive", { timeout: BUILD_TIMEOUT })
})

test("the upload route checks the session, origin and header itself (it skips proxy.ts)", async ({ page, baseURL }) => {
  const url = `${baseURL}/api/images/build/upload`
  const options = { "x-gantry-build-options": encodeURIComponent(JSON.stringify({ filename: "x.tar", options: { tags: "gantry-test-b-x" } })) }
  expect((await fetch(url, { method: "POST", headers: options, body: "x" })).status).toBe(401)
  // API tokens are refused here (browser sessions only).
  const bearer = { ...options, Authorization: `Bearer gtk_${"a".repeat(43)}` }
  expect((await fetch(url, { method: "POST", headers: bearer, body: "x" })).status).toBe(401)
  await signIn(page)
  const crossSite = await page.request.post(url, { headers: { ...options, "sec-fetch-site": "cross-site" }, data: "x" })
  expect(crossSite.status()).toBe(403)
  // What a cross-site form could send: no custom header.
  expect((await page.request.post(url, { data: "x" })).status()).toBe(400)
  const invalid = await page.request.post(url, { headers: { "x-gantry-build-options": "%7Bnot-json" }, data: "x" })
  expect(invalid.status()).toBe(400)
})

test("tags and pushes to a private registry, then builds on its image and pushes", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page)
  const pushed = `${REPO}:1`

  // Tag the editor build for the registry.
  let row = await findImageRow(page, EDITOR_TAG)
  await row.getByRole("button", { name: `Tag ${EDITOR_TAG}` }).click()
  const tagDialog = page.getByRole("dialog")
  await tagDialog.getByLabel("New tag").fill(pushed)
  await tagDialog.getByRole("button", { name: "Tag" }).click()
  await expect(page.getByText(`Tagged as ${pushed}`)).toBeVisible()
  await expect(row).toContainText(pushed)

  // Without a stored login the push fails readably and points to Registries.
  const openPush = async () => {
    await row.getByRole("button", { name: `Push ${EDITOR_TAG}` }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByRole("combobox", { name: "Tag to push" }).click()
    await page.getByRole("option", { name: pushed }).click()
    await dialog.getByRole("button", { name: "Push", exact: true }).click()
    return dialog
  }
  let dialog = await openPush()
  await expect(dialog.getByRole("alert")).toContainText("Push failed", { timeout: BUILD_TIMEOUT })
  await expect(dialog.getByRole("alert")).toContainText(`${HOST} requires a login to push ${pushed}, and none is configured`)
  await expect(dialog.getByRole("link", { name: "Open Registries" })).toBeVisible()
  await page.keyboard.press("Escape")

  await page.goto("/registries")
  await page.getByRole("button", { name: "Add registry" }).click()
  const add = page.getByRole("dialog")
  await add.getByLabel("Name", { exact: true }).fill("gantry-test-b registry")
  await add.getByLabel("Registry").fill(HOST)
  await add.getByLabel("Username").fill(REG_USER)
  await add.getByLabel("Password or access token").fill(REG_PASSWORD)
  await add.getByRole("button", { name: "Save" }).click()
  await expect(add).toBeHidden({ timeout: 60_000 })

  row = await findImageRow(page, EDITOR_TAG)
  dialog = await openPush()
  await expect(dialog.getByRole("status").filter({ hasText: "Push succeeded" })).toBeVisible({ timeout: BUILD_TIMEOUT })
  await expect(dialog.getByRole("log", { name: "Push log" })).toContainText(`Pushing ${pushed} to ${HOST} as ${REG_USER}`)
  await page.keyboard.press("Escape")

  // It is in the registry.
  const catalog = await registryGet<{ repositories: string[] }>("/v2/_catalog")
  expect(catalog.repositories).toContain("gantry-test-b/app")
  expect((await registryGet<{ tags: string[] }>("/v2/gantry-test-b/app/tags/list")).tags).toContain("1")

  // A build on that private image: "Always pull" fetches it with the stored
  // login (X-Registry-Config), "Push after build" pushes the result.
  await docker("DELETE", `/images/${encodeURIComponent(pushed)}`)
  await fillEditorBuild(page, { dockerfile: `FROM ${pushed}\nRUN echo second build > /second\n`, tags: `${REPO}:2` })
  await page.getByRole("checkbox", { name: "Always pull base images" }).click()
  await page.getByRole("checkbox", { name: "Push after build" }).click()
  await page.getByRole("button", { name: "Build image" }).click()
  await expect(result(page)).toContainText("Build succeeded", { timeout: BUILD_TIMEOUT })
  await expect(result(page)).toContainText(`Pushed ${REPO}:2`)
  await expect(buildLog(page)).toContainText(`Pushing ${REPO}:2 to ${HOST} as ${REG_USER}`)
  expect((await registryGet<{ tags: string[] }>("/v2/gantry-test-b/app/tags/list")).tags).toEqual(expect.arrayContaining(["1", "2"]))
})
