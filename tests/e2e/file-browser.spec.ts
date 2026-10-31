import fs from "node:fs/promises"

import { expect, test, type Browser, type Download, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable, removeContainer } from "./docker"

// Runs after the "login" project, which creates the ADMIN account. Covers the
// file browser (containers, stopped containers, volumes), log download and
// search, and that viewers can't read files. Everything it creates is named
// gantry-test-f-* and removed afterwards.
test.describe.configure({ mode: "serial" })

const PREFIX = "gantry-test-f"
const CONTAINER = `${PREFIX}-c1`
const STOPPED = `${PREFIX}-c2`
const READER = `${PREFIX}-reader`
const VOLUME = `${PREFIX}-vol`
const VIEWER = { username: `${PREFIX}-viewer`, password: "e2e-Viewer-Passw0rd" }
// Creating containers (volume helpers) can take minutes on a busy Docker host.
const SLOW = 600_000
const timeout = 300_000
let containerId = ""
let stoppedId = ""

const LOG_SCRIPT = [
  "for i in $(seq 1 30); do echo \"line $i alpha\"; done",
  "echo 'Needle-ONE here'",
  "echo 'needle-two there' >&2",
  "exec sleep 900",
].join("; ")

async function ensureAlpine() {
  try {
    await docker("GET", `/images/${encodeURIComponent("alpine:3")}/json`)
  } catch {
    await docker("POST", "/images/create?fromImage=alpine&tag=3")
  }
}

async function create(name: string, cmd: string[], binds: string[] = []) {
  const { Id } = await docker<{ Id: string }>("POST", `/containers/create?name=${name}`, {
    Image: "alpine:3",
    Cmd: cmd,
    Labels: { "gantry.e2e": "true" },
    HostConfig: { Binds: binds },
  })
  return Id
}

async function runToEnd(name: string, cmd: string[], binds: string[] = []) {
  const id = await create(name, cmd, binds)
  await docker("POST", `/containers/${id}/start`)
  await docker("POST", `/containers/${id}/wait`)
  return id
}

async function cleanup() {
  for (const name of [CONTAINER, STOPPED, READER]) await removeContainer(name)
  // Gantry keeps an idle volume helper for a while; it would keep the volume in use.
  const filters = encodeURIComponent(JSON.stringify({ label: ["gantry.helper=files", `gantry.helper.volume=${VOLUME}`] }))
  const helpers = await docker<{ Id: string }[]>("GET", `/containers/json?all=1&filters=${filters}`).catch(() => [])
  for (const h of helpers) await removeContainer(h.Id)
  await docker("DELETE", `/volumes/${VOLUME}?force=true`).catch(() => {})
}

async function signIn(page: Page, creds: { username: string; password: string } = ADMIN) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(creds.username)
  await page.getByLabel("Password").fill(creds.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function as(browser: Browser, creds: { username: string; password: string }) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, creds)
  return { context, page }
}

async function saved(download: Download) {
  return fs.readFile((await download.path())!, "utf8")
}

async function goTo(page: Page, path: string) {
  // The first listing has arrived (and the page is interactive).
  await expect(page.getByRole("table", { name: "Files" })).toBeVisible({ timeout })
  await page.getByLabel("Go to path").fill(path)
  await page.getByLabel("Go to path").press("Enter")
  await expect(page.getByLabel("Path").locator('[aria-current="page"]')).toHaveText(path.split("/").pop()!, { timeout })
}

const row = (page: Page, name: string) => page.getByTestId(`file-row-${name}`)

test.beforeAll(async () => {
  test.setTimeout(SLOW)
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  await cleanup()
  await ensureAlpine()
  containerId = await create(CONTAINER, ["sh", "-c", LOG_SCRIPT])
  await docker("POST", `/containers/${containerId}/start`)
  stoppedId = await runToEnd(STOPPED, ["sh", "-c", "mkdir -p /srv && echo stopped-content > /srv/marker.txt"])
  await docker("POST", "/volumes/create", { Name: VOLUME, Labels: { "gantry.e2e": "true" } })
})

test.afterAll(async () => {
  test.setTimeout(SLOW)
  await cleanup()
})

test("browse /etc in a running container and download a file", async ({ page }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  await page.goto(`/containers/${containerId}?tab=files`)
  await expect(page.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true")
  await page.getByRole("button", { name: "Open etc" }).click({ timeout })
  await expect(row(page, "os-release")).toBeVisible({ timeout })
  await expect(row(page, "os-release")).toContainText("root:root")
  // Folders first, then breadcrumbs lead back up.
  await expect(page.getByLabel("Path").locator('[aria-current="page"]')).toHaveText("etc")

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    row(page, "os-release").getByRole("link", { name: "Download os-release" }).click(),
  ])
  expect(download.suggestedFilename()).toBe("os-release")
  expect(await saved(download)).toContain("Alpine")

  await page.getByRole("button", { name: `${CONTAINER} (root)` }).click()
  await expect(page.getByRole("button", { name: "Open etc" })).toBeVisible({ timeout })
})

test("upload, edit, save and re-read a file", async ({ page }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  await page.goto(`/containers/${containerId}?tab=files`)
  await goTo(page, "/tmp")
  await page.getByLabel("Files to upload").setInputFiles({
    name: "gantry-e2e.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello from e2e\n"),
  })
  await expect(page.getByText("Uploaded gantry-e2e.txt")).toBeVisible({ timeout })
  await expect(row(page, "gantry-e2e.txt")).toContainText("15 B")

  await row(page, "gantry-e2e.txt").getByRole("button", { name: "Edit gantry-e2e.txt" }).click()
  const dialog = page.getByRole("dialog")
  const content = dialog.getByLabel("File content")
  await expect(content).toHaveValue("hello from e2e\n", { timeout })
  await content.fill("edited by e2e\nsecond line\n")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Saved gantry-e2e.txt")).toBeVisible({ timeout })
  await expect(dialog).toBeHidden()

  // Read back through the UI and the API.
  await row(page, "gantry-e2e.txt").getByRole("button", { name: "Edit gantry-e2e.txt" }).click()
  await expect(page.getByRole("dialog").getByLabel("File content")).toHaveValue("edited by e2e\nsecond line\n", { timeout })
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()
  const read = await page.request.get(`/api/files/read?container=${containerId}&path=/tmp/gantry-e2e.txt`)
  expect(await read.json()).toMatchObject({ ok: true, content: "edited by e2e\nsecond line\n" })

  // Uploading the same name again asks before replacing.
  await page.getByLabel("Files to upload").setInputFiles({ name: "gantry-e2e.txt", mimeType: "text/plain", buffer: Buffer.from("v3\n") })
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace" }).click()
  await expect(row(page, "gantry-e2e.txt")).toContainText("3 B", { timeout })
})

test("create and delete a folder", async ({ page }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  await page.goto(`/containers/${containerId}?tab=files`)
  await goTo(page, "/tmp")
  await page.getByRole("button", { name: "New folder" }).click()
  await page.getByRole("dialog").getByLabel("Folder name").fill("e2e dir")
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click()
  await expect(row(page, "e2e dir")).toBeVisible({ timeout })
  await expect(row(page, "e2e dir")).toContainText("folder")

  await row(page, "e2e dir").getByRole("button", { name: "Delete e2e dir" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByText("Deleted /tmp/e2e dir")).toBeVisible({ timeout })
  await expect(row(page, "e2e dir")).toHaveCount(0)
})

test("browse a stopped container", async ({ page }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  await page.goto(`/containers/${stoppedId}?tab=files`)
  await goTo(page, "/srv")
  await expect(row(page, "marker.txt")).toBeVisible({ timeout })
  await expect(page.getByTestId("files-archive-note")).toBeVisible()
  // Deleting needs a running container: disabled, with the reason.
  await expect(page.getByTestId("files-delete-blocker")).toContainText("running container")
  await expect(row(page, "marker.txt").getByRole("button", { name: "Delete marker.txt" })).toBeDisabled()

  await row(page, "marker.txt").getByRole("button", { name: "Edit marker.txt" }).click()
  await expect(page.getByRole("dialog").getByLabel("File content")).toHaveValue("stopped-content\n", { timeout })
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click()

  // Writing works without a running container (Docker's archive API).
  await page.getByLabel("Files to upload").setInputFiles({ name: "added.txt", mimeType: "text/plain", buffer: Buffer.from("added\n") })
  await expect(row(page, "added.txt")).toBeVisible({ timeout })
})

test("browse a volume, upload, and see the file from another container", async ({ page }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  await page.goto("/volumes")
  await page.getByLabel("Search").fill(VOLUME)
  await page.getByRole("link", { name: `Browse volume ${VOLUME}` }).click()
  await expect(page).toHaveURL(new RegExp(`/volumes/${VOLUME}$`))
  await expect(page.getByRole("heading", { name: VOLUME })).toBeVisible()
  await expect(page.getByText("No container mounts this volume.")).toBeVisible()
  await expect(page.getByText("Empty folder.")).toBeVisible({ timeout })

  await page.getByLabel("Files to upload").setInputFiles({
    name: "from-gantry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("written through the volume browser\n"),
  })
  await expect(page.getByText("Uploaded from-gantry.txt")).toBeVisible({ timeout })
  await expect(row(page, "from-gantry.txt")).toBeVisible({ timeout })

  // Another container sees it.
  const readerId = await runToEnd(READER, ["cat", "/data/from-gantry.txt"], [`${VOLUME}:/data:ro`])
  const logs = await docker<string>("GET", `/containers/${readerId}/logs?stdout=1&stderr=1`)
  expect(String(logs)).toContain("written through the volume browser")

  // Now the volume is in use: the page says so and asks before changing it.
  await page.reload()
  await expect(page.getByTestId("volume-used-by")).toContainText(READER)
  await expect(row(page, "from-gantry.txt")).toBeVisible({ timeout })
  await page.getByRole("button", { name: "New folder" }).click()
  const warning = page.getByRole("alertdialog")
  await expect(warning).toContainText(`mounted by ${READER}`)
  await warning.getByRole("button", { name: "Continue" }).click()
  await page.getByRole("dialog").getByLabel("Folder name").fill("sub")
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click()
  await expect(row(page, "sub")).toBeVisible({ timeout })

  // Download from the volume.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout }),
    row(page, "from-gantry.txt").getByRole("link", { name: "Download from-gantry.txt" }).click(),
  ])
  expect(await saved(download)).toBe("written through the volume browser\n")
})

test("download logs and search them", async ({ page }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  await page.goto(`/containers/${containerId}`)
  const output = page.getByTestId("log-output")
  await expect(output).toContainText("needle-two there", { timeout })

  // Search: case-insensitive, counted, next/previous, only matching lines.
  await page.getByLabel("Search logs").fill("NEEDLE")
  await expect(page.getByTestId("log-match-count")).toHaveText("1 of 2")
  await expect(output.locator("mark")).toHaveCount(2)
  await expect(output.locator("mark[data-active]")).toHaveText("Needle")
  await page.getByRole("button", { name: "Next match" }).click()
  await expect(page.getByTestId("log-match-count")).toHaveText("2 of 2")
  await expect(output.locator("mark[data-active]")).toHaveText("needle")
  await page.getByRole("button", { name: "Next match" }).click()
  await expect(page.getByTestId("log-match-count")).toHaveText("1 of 2")
  await page.getByRole("button", { name: "Previous match" }).click()
  await expect(page.getByTestId("log-match-count")).toHaveText("2 of 2")
  await expect(output).toContainText("line 7 alpha")
  await page.getByText("Only matching lines").click()
  await expect(output).not.toContainText("line 7 alpha")
  await expect(output.locator("div")).toHaveCount(2)
  await page.getByLabel("Search logs").fill("no such text")
  await expect(page.getByTestId("log-match-count")).toHaveText("No matches")

  // Download: the whole log with timestamps.
  await page.getByRole("button", { name: "Download", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByRole("checkbox", { name: "Include timestamps" })).toBeChecked()
  const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("link", { name: "Download .log" }).click()])
  expect(download.suggestedFilename()).toMatch(new RegExp(`^${CONTAINER}-.*\\.log$`))
  const text = await saved(download)
  const lines = text.trim().split("\n")
  expect(lines).toHaveLength(32)
  expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\S+Z line 1 alpha$/)
  expect(text).toContain("needle-two there")

  // Options: no timestamps, last 2 lines; bad options are refused.
  const tail = await page.request.get(`/api/containers/${containerId}/logs/download?tail=2`)
  expect(tail.headers()["content-disposition"]).toContain("attachment")
  expect((await tail.text()).trim().split("\n").sort()).toEqual(["Needle-ONE here", "needle-two there"])
  const future = Math.floor(Date.now() / 1000) + 3600
  expect((await (await page.request.get(`/api/containers/${containerId}/logs/download?since=${future}`)).text())).toBe("")
  expect((await page.request.get(`/api/containers/${containerId}/logs/download?tail=-1`)).status()).toBe(400)
})

test("paths are validated and writes need a same-origin manager session", async ({ page }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  const list = (path: string) => page.request.get(`/api/files/list?container=${containerId}&path=${encodeURIComponent(path)}`)
  expect((await list("/../etc")).status()).toBe(400)
  expect((await list("/nope/missing")).status()).toBe(404)
  expect((await page.request.get(`/api/files/list?container=not-an-id&path=/`)).status()).toBe(400)
  const put = (name: string, headers: Record<string, string> = {}) =>
    page.request.put(`/api/uploads/files?container=${containerId}&path=/tmp&name=${encodeURIComponent(name)}`, {
      data: Buffer.from("x"),
      headers,
    })
  expect((await put("../escape")).status()).toBe(400)
  expect((await put("ok.txt", { "Sec-Fetch-Site": "cross-site" })).status()).toBe(403)
  expect((await put("ok.txt")).status()).toBe(200)
})

test("a viewer can't browse or download files", async ({ page, browser }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  await page.goto("/users")
  await page.getByRole("button", { name: "Add user" }).click()
  const add = page.getByRole("dialog")
  await add.getByLabel("Username").fill(VIEWER.username)
  await add.getByLabel("Password").fill(VIEWER.password)
  await add.getByRole("button", { name: "Create" }).click()
  await expect(add).toBeHidden()
  await page.getByRole("button", { name: `Environment access for ${VIEWER.username}` }).click()
  const access = page.getByRole("dialog")
  await access.getByRole("checkbox", { name: "local" }).check()
  await access.getByRole("combobox", { name: "Role for local" }).click()
  await page.getByRole("option", { name: "Viewer", exact: true }).click()
  await access.getByRole("button", { name: "Save" }).click()
  await expect(page.getByTestId(`user-envs-${VIEWER.username}`)).toHaveText("local viewer")

  const { context, page: viewer } = await as(browser, VIEWER)
  await viewer.goto(`/containers/${containerId}?tab=files`)
  await expect(viewer.getByTestId("logs-hidden")).toBeVisible({ timeout })
  await expect(viewer.getByRole("tab", { name: "Files" })).toHaveCount(0)
  await viewer.goto(`/volumes/${VOLUME}`)
  await expect(viewer.getByTestId("files-hidden")).toBeVisible({ timeout })

  // The server refuses too.
  const forbidden = [
    `/api/files/download?container=${containerId}&path=/etc/os-release`,
    `/api/files/list?container=${containerId}&path=/etc`,
    `/api/files/read?container=${containerId}&path=/etc/os-release`,
    `/api/files/download?volume=${VOLUME}&path=/from-gantry.txt`,
    `/api/containers/${containerId}/logs/download`,
  ]
  for (const url of forbidden) {
    const res = await viewer.request.get(url)
    expect(res.status(), url).toBe(403)
    expect((await res.json()).error).toMatch(/operator role/)
  }
  const upload = await viewer.request.put(`/api/uploads/files?container=${containerId}&path=/tmp&name=v.txt`, { data: Buffer.from("x") })
  expect(upload.status()).toBe(403)
  await context.close()
})
