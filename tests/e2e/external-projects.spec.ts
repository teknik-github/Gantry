import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable } from "./docker"

// A compose project started outside Gantry (docker compose CLI), managed from
// the "External projects" table: stop, start, restart, pull & redeploy, remove.
test.describe.configure({ mode: "serial" })

const PROJECT = `gantry-test-x-e2e-${Date.now().toString(36)}`
const COMPOSE = `services:
  db:
    image: alpine:3
    command: ["sleep", "900"]
    init: true
    stop_grace_period: 2s
    volumes: [data:/data]
    labels: { gantry.e2e: "true" }
  web:
    image: alpine:3
    command: ["sleep", "900"]
    init: true
    stop_grace_period: 2s
    depends_on: [db]
    labels: { gantry.e2e: "true" }
volumes:
  data:
    labels: { gantry.e2e: "true" }
networks:
  default:
    labels: { gantry.e2e: "true" }
`
let dir = ""

const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${PROJECT}`] }))
const containers = () =>
  docker<{ Id: string; State: string; Names: string[] }[]>("GET", `/containers/json?all=true&filters=${filters}`)
const states = async () => (await containers()).map((c) => c.State).sort()

test.beforeAll(async () => {
  test.setTimeout(240_000)
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-e2e-external-"))
  fs.writeFileSync(path.join(dir, "compose.yaml"), COMPOSE)
  execFileSync("docker", ["compose", "-p", PROJECT, "-f", path.join(dir, "compose.yaml"), "up", "-d"], { stdio: "pipe" })
})

// Whatever is left: only this project's containers, networks and volumes.
test.afterAll(async () => {
  test.setTimeout(120_000)
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  if (!(await dockerAvailable())) return
  for (const c of await containers().catch(() => [])) await docker("DELETE", `/containers/${c.Id}?force=true&v=true`).catch(() => {})
  const networks = await docker<{ Id: string }[]>("GET", `/networks?filters=${filters}`).catch(() => [])
  for (const n of networks) await docker("DELETE", `/networks/${n.Id}`).catch(() => {})
  const volumes = await docker<{ Volumes: { Name: string }[] | null }>("GET", `/volumes?filters=${filters}`).catch(() => null)
  for (const v of volumes?.Volumes ?? []) await docker("DELETE", `/volumes/${v.Name}`).catch(() => {})
})

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function openMenu(page: Page) {
  await page.goto("/stacks")
  const row = page.getByRole("row").filter({ hasText: PROJECT })
  await expect(row).toHaveCount(1, { timeout: 60_000 })
  await row.getByRole("button", { name: "Open menu" }).click()
}

test("stop and start an external project", async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page)
  expect(await states()).toEqual(["running", "running"])

  await openMenu(page)
  await page.getByRole("menuitem", { name: "Stop", exact: true }).click()
  await expect(page.getByText(`${PROJECT}: stopped 2 container(s)`)).toBeVisible({ timeout: 120_000 })
  expect(await states()).toEqual(["exited", "exited"])

  await openMenu(page)
  // Nothing is running, so Stop isn't offered.
  await expect(page.getByRole("menuitem", { name: "Stop", exact: true })).toHaveCount(0)
  await page.getByRole("menuitem", { name: "Start", exact: true }).click()
  await expect(page.getByText(`${PROJECT}: started 2 container(s)`)).toBeVisible({ timeout: 120_000 })
  expect(await states()).toEqual(["running", "running"])
})

test("restart and pull & redeploy keep the project together", async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)
  await openMenu(page)
  await page.getByRole("menuitem", { name: "Restart", exact: true }).click()
  await expect(page.getByText(`${PROJECT}: restarted 2 container(s)`)).toBeVisible({ timeout: 120_000 })

  await openMenu(page)
  await page.getByRole("menuitem", { name: "Pull & redeploy" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Pull & redeploy" }).click()
  // alpine:3 is normally current; if upstream just moved the tag both are recreated.
  await expect(page.getByText(new RegExp(`${PROJECT}: \\d container\\(s\\) updated, \\d already up to date`))).toBeVisible({
    timeout: 240_000,
  })
  // Still one project of two running containers (recreated ones keep their compose labels).
  expect(await states()).toEqual(["running", "running"])
})

test("remove takes the project down, volumes only when asked", async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page)
  await openMenu(page)
  await page.getByRole("menuitem", { name: "Remove", exact: true }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog).toContainText("like docker compose down")
  await dialog.getByLabel("Also remove the project's volumes").click()
  await dialog.getByRole("button", { name: "Remove" }).click()
  await expect(page.getByText(`${PROJECT} removed`)).toBeVisible({ timeout: 120_000 })

  expect(await containers()).toEqual([])
  const networks = await docker<unknown[]>("GET", `/networks?filters=${filters}`)
  expect(networks).toEqual([])
  const volumes = await docker<{ Volumes: unknown[] | null }>("GET", `/volumes?filters=${filters}`)
  expect(volumes.Volumes ?? []).toEqual([])
  await page.goto("/stacks")
  await expect(page.getByRole("row").filter({ hasText: PROJECT })).toHaveCount(0)
})
