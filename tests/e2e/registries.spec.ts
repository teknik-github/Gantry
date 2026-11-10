import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { registryAuthHeader } from "../../lib/registry"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable, removeContainer } from "./docker"

// Runs after the "login" project, which creates the ADMIN account.
// A real private registry (registry:2 with htpasswd) on localhost: pulls
// need the login stored in Gantry, for the Engine API (Images, update) and
// for docker compose (Stacks). Then an image update is detected and applied.
test.describe.configure({ mode: "serial" })

const PORT = 15000 + Math.floor(Math.random() * 1000)
const HOST = `localhost:${PORT}`
const REPO = `${HOST}/gantry-e2e/app`
const IMAGE = `${REPO}:1`
const USER = "gantry"
const PASSWORD = "e2e-registry-pass"
const REGISTRY = "gantry-test-h-registry"
const APP = "gantry-test-h-app"
const STACK = `gantry-test-h-stack-${Date.now().toString(36)}`
const LABELS = { "gantry.e2e": "true" }

const TIMEOUT = 300_000
const timeout = 60_000

let tmp = ""

/** docker CLI with a private config dir (never touches the user's logins). */
function cli(...args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, DOCKER_CONFIG: path.join(tmp, "cli") },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim()
}

/**
 * Untags this registry's images. By tag, never by id: a tag made from
 * alpine:3 shares its id, and deleting the id would remove alpine:3 too.
 */
async function removeLocalImages() {
  const images = await docker<{ Id: string; RepoTags: string[] | null }[]>("GET", "/images/json").catch(() => [])
  for (const img of images) {
    for (const tag of img.RepoTags ?? []) {
      if (tag.startsWith(`${HOST}/`)) await docker("DELETE", `/images/${encodeURIComponent(tag)}`).catch(() => {})
    }
  }
}

async function cleanup() {
  await removeContainer(APP)
  await removeContainer(`${APP}-v2`)
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${STACK}`] }))
  const containers = await docker<{ Id: string }[]>("GET", `/containers/json?all=true&filters=${filters}`).catch(() => [])
  for (const c of containers) await docker("DELETE", `/containers/${c.Id}?force=true`).catch(() => {})
  const networks = await docker<{ Id: string }[]>("GET", `/networks?filters=${filters}`).catch(() => [])
  for (const n of networks) await docker("DELETE", `/networks/${n.Id}`).catch(() => {})
  await removeContainer(REGISTRY)
  await removeLocalImages()
}

test.beforeAll(async () => {
  test.setTimeout(TIMEOUT)
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-e2e-registry-"))
  fs.mkdirSync(path.join(tmp, "cli"))
  fs.mkdirSync(path.join(tmp, "auth"))
  await cleanup()

  // bcrypt htpasswd entry (caddy ships a bcrypt hasher).
  const hash = cli("run", "--rm", "caddy:2-alpine", "caddy", "hash-password", "--plaintext", PASSWORD)
  fs.writeFileSync(path.join(tmp, "auth", "htpasswd"), `${USER}:${hash}\n`)
  cli(
    "run", "-d", "--name", REGISTRY, "--label", "gantry.e2e=true",
    "-p", `127.0.0.1:${PORT}:5000`,
    "-v", `${path.join(tmp, "auth")}:/auth:ro`,
    "-e", "REGISTRY_AUTH=htpasswd",
    "-e", "REGISTRY_AUTH_HTPASSWD_REALM=gantry-e2e",
    "-e", "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
    "registry:2"
  )
  // Push version 1, then forget it locally so Gantry has to pull it.
  for (let i = 0; ; i++) {
    try {
      execFileSync("docker", ["login", HOST, "-u", USER, "--password-stdin"], {
        input: PASSWORD,
        env: { ...process.env, DOCKER_CONFIG: path.join(tmp, "cli") },
        stdio: ["pipe", "pipe", "pipe"],
      })
      break
    } catch (err) {
      if (i > 20) throw err
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  cli("tag", "alpine:3", IMAGE)
  cli("push", IMAGE)
  await removeLocalImages()
})

test.afterAll(async () => {
  test.setTimeout(TIMEOUT)
  await cleanup()
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function pullFromImagesPage(page: Page) {
  await page.goto("/images")
  await page.getByRole("button", { name: "Pull image" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Image").fill(IMAGE)
  await dialog.getByRole("button", { name: "Pull" }).click()
  return dialog
}

test("private images need a registry login stored in Gantry", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page)

  // Without a login the registry refuses.
  const dialog = await pullFromImagesPage(page)
  await expect(dialog).toContainText(/unauthorized|no basic auth credentials|authentication required/i, { timeout })
  await page.keyboard.press("Escape")

  await page.goto("/registries")
  await page.getByRole("button", { name: "Add registry" }).click()
  const add = page.getByRole("dialog")
  await add.getByLabel("Name", { exact: true }).fill("E2E registry")
  await add.getByLabel("Registry").fill(`http://${HOST}/`)
  await add.getByLabel("Username").fill(USER)

  // A wrong password is caught by the login check and nothing is saved.
  await add.getByLabel("Password or access token").fill("wrong-password")
  await add.getByRole("button", { name: "Save" }).click()
  await expect(add).toContainText(`Login to ${HOST} failed`, { timeout })

  await add.getByLabel("Password or access token").fill(PASSWORD)
  await add.getByRole("button", { name: "Save" }).click()
  await expect(add).toBeHidden({ timeout })
  // Address normalised; the password is never sent back to the browser.
  const row = page.getByRole("row").filter({ hasText: "E2E registry" })
  await expect(row).toContainText(HOST)
  await expect(page.locator("body")).not.toContainText(PASSWORD)

  await row.getByRole("button", { name: `Test login to ${HOST}` }).click()
  await expect(page.getByText(`Logged in to ${HOST} as ${USER}`)).toBeVisible({ timeout })

  // Now the pull goes through.
  const again = await pullFromImagesPage(page)
  await expect(again).toBeHidden({ timeout })
  await expect(page.getByText(`Pulled ${IMAGE}`)).toBeVisible()
  // A copy of alpine:3, so old: search instead of relying on the first page.
  await page.getByRole("textbox", { name: "Search" }).fill(IMAGE)
  // The toast comes with the action's result; the refreshed list streams in
  // after it, once Docker has listed the images again. That listing alone can
  // take well over 15 s on a busy host with the containerd image store, so
  // wait like the other Docker-bound steps here.
  await expect(page.getByRole("row").filter({ hasText: IMAGE })).toHaveCount(1, { timeout })
})

test("stacks pull private images with the stored login", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await removeLocalImages()
  await signIn(page)
  await page.goto("/stacks/new")
  await page.getByLabel("Name").fill(STACK)
  await page.getByLabel("Compose file").fill(`services:
  app:
    image: ${IMAGE}
    command: ["sleep", "600"]
    init: true
    labels:
      gantry.e2e: "true"
networks:
  default:
    labels:
      gantry.e2e: "true"
`)
  await page.getByRole("button", { name: "Create & deploy" }).click()
  await expect(page).toHaveURL(/\/stacks\/\d+$/, { timeout: 120_000 })
  await expect(page.getByRole("main").getByRole("heading", { level: 2, name: STACK })).toContainText("1/1", { timeout })

  await page.getByRole("button", { name: "Delete" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page).toHaveURL(/\/stacks$/, { timeout })
})

test("an image update is detected and applied from the containers list", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  // A container on version 1 (pulled through Gantry's login in the first test or the stack).
  await docker("POST", `/images/create?fromImage=${encodeURIComponent(REPO)}&tag=1`, undefined, {
    "X-Registry-Auth": registryAuthHeader({ address: HOST, username: USER, password: PASSWORD }),
  })
  const { Id } = await docker<{ Id: string }>("POST", `/containers/create?name=${APP}`, {
    Image: IMAGE,
    Cmd: ["sleep", "900"],
    Labels: LABELS,
  })
  await docker("POST", `/containers/${Id}/start`)

  // Version 2 of the same tag lands in the registry.
  cli("run", "--name", `${APP}-v2`, IMAGE, "sh", "-c", "echo v2 > /version")
  cli("commit", `${APP}-v2`, IMAGE)
  cli("push", IMAGE)
  await removeContainer(`${APP}-v2`)

  await signIn(page)
  await page.goto("/containers")
  await page.getByLabel("Search").fill(APP)
  const row = page.getByRole("row").filter({ hasText: APP })
  await expect(row).toHaveCount(1)
  // Listed by its tag, not by the image id Docker reports once the tag moved.
  await expect(row).toContainText(IMAGE)
  await expect(row.getByTestId("update-badge")).toHaveCount(0)

  await page.getByRole("button", { name: "Check updates" }).click()
  await expect(page.getByText(/Checked \d+ image tag\(s\): \d+ container\(s\) can be updated/)).toBeVisible({ timeout })
  await expect(row.getByTestId("update-badge")).toBeVisible({ timeout })

  await page.getByLabel(`Select ${APP}`).click()
  await page.getByTestId("bulk-bar").getByRole("button", { name: /^Update/ }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog.getByTestId("bulk-names")).toContainText(APP)
  await dialog.getByRole("button", { name: "Update" }).click()
  await expect(page.getByText("Updated 1 container")).toBeVisible({ timeout: 120_000 })

  // Recreated from the new image, still running, badge gone.
  const recreated = await docker<{ Id: string; State: { Running: boolean }; Image: string }>("GET", `/containers/${APP}/json`)
  expect(recreated.Id).not.toBe(Id)
  expect(recreated.State.Running).toBe(true)
  await expect(row).toContainText(/running/i, { timeout })
  await expect(row.getByTestId("update-badge")).toHaveCount(0, { timeout })
})

test("auto-update recreates opted-in containers when their tag has a newer image", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  // Version 3 lands in the registry.
  cli("run", "--name", `${APP}-v2`, IMAGE, "sh", "-c", "echo v3 > /version")
  cli("commit", `${APP}-v2`, IMAGE)
  cli("push", IMAGE)
  await removeContainer(`${APP}-v2`)
  const before = await docker<{ Id: string }>("GET", `/containers/${APP}/json`)

  await signIn(page)
  await page.goto("/auto-update")
  await page.getByRole("textbox", { name: "Search" }).fill(APP)
  const toggle = page.getByRole("switch", { name: `Auto-update ${APP}` })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  await expect(page.getByText(`${APP}: auto-update on`)).toBeVisible()
  await expect(toggle).toBeChecked()

  // The schedule can be saved (validated as HH:MM).
  await page.getByRole("checkbox", { name: "Run every day" }).click()
  await page.getByLabel("At", { exact: true }).fill("04:30")
  await page.getByRole("button", { name: "Save schedule" }).click()
  await expect(page.getByText("Auto-update runs daily at 04:30")).toBeVisible()
  await expect(page.getByRole("checkbox", { name: "Run every day" })).toBeChecked()

  await page.getByRole("button", { name: "Run now" }).click()
  await expect(page.getByText(/Auto-update finished: 1 updated/)).toBeVisible({ timeout: 180_000 })
  const result = page.getByRole("row").filter({ hasText: APP }).filter({ hasText: "updated" })
  await expect(result).toBeVisible()

  const after = await docker<{ Id: string; State: { Running: boolean } }>("GET", `/containers/${APP}/json`)
  expect(after.Id).not.toBe(before.Id)
  expect(after.State.Running).toBe(true)

  // Nothing new: a second run leaves it alone.
  await page.getByRole("button", { name: "Run now" }).click()
  await expect(page.getByText(/Auto-update finished: 0 updated, 1 up to date/)).toBeVisible({ timeout: 120_000 })
})

test("registry logins can be edited without retyping the password, and removed", async ({ page }) => {
  await signIn(page)
  await page.goto("/registries")
  const row = page.getByRole("row").filter({ hasText: "E2E registry" })
  await row.getByRole("button", { name: "Edit E2E registry" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name", { exact: true }).fill("E2E registry renamed")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden({ timeout })
  await expect(page.getByText("Registry E2E registry renamed saved")).toBeVisible()

  const renamed = page.getByRole("row").filter({ hasText: "E2E registry renamed" })
  await renamed.getByRole("button", { name: `Test login to ${HOST}` }).click()
  await expect(page.getByText(`Logged in to ${HOST} as ${USER}`)).toBeVisible({ timeout })

  await renamed.getByRole("button", { name: "Remove E2E registry renamed" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await expect(page.getByRole("row").filter({ hasText: "E2E registry" })).toHaveCount(0)
})
