import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable, removeContainer, startScratchContainer } from "./docker"

// Runs after the "login" project, which creates the ADMIN account.
test.describe.configure({ mode: "serial" })

// Names (Docker accepts them as ids) so cleanup works even if the test dies mid-create.
const created: string[] = []

test.afterAll(async () => {
  for (const name of created) await removeContainer(name)
})

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

test("live updates and metrics require a session", async ({ playwright, baseURL }) => {
  const anon = await playwright.request.newContext({ baseURL })
  for (const path of ["/api/events", "/api/events?probe=1", "/api/metrics", "/api/metrics?range=24h"]) {
    const res = await anon.get(path)
    expect(res.status(), path).toBe(401)
    expect(await res.json()).toEqual({ error: "Unauthorized" })
  }
  await anon.dispose()
})

test("the containers page follows Docker without reloading", async ({ page }) => {
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  test.setTimeout(240_000)
  await signIn(page)
  await page.goto("/containers")
  await expect(page.getByTestId("live-indicator")).toHaveAttribute("data-status", "connected")

  // Client state that a reload would lose: a marker on window and the search box.
  await page.evaluate(() => ((window as unknown as { __gantryNoReload: boolean }).__gantryNoReload = true))
  const name = `gantry-test-d-live-${Date.now()}`
  await page.getByLabel("Search").fill(name)
  await expect(page.getByRole("link", { name })).toHaveCount(0)

  created.push(name)
  const id = await startScratchContainer(name)
  // Normally a second or two; generous because the Docker host is shared and busy.
  const timeout = 45_000
  const row = page.getByRole("row").filter({ hasText: name })
  await expect(row).toBeVisible({ timeout })
  await expect(row).toContainText(/running/i, { timeout })

  // Stopping is picked up as well...
  await docker("POST", `/containers/${id}/stop?t=0`)
  await expect(row).toContainText(/exited/i, { timeout })

  // ...and so is removal.
  await removeContainer(id)
  await expect(row).toHaveCount(0, { timeout })

  await expect(page.getByLabel("Search")).toHaveValue(name)
  expect(await page.evaluate(() => (window as unknown as { __gantryNoReload?: boolean }).__gantryNoReload)).toBe(true)
})

test("metrics history answers for every range and rejects others", async ({ page }) => {
  await signIn(page)
  for (const range of ["1h", "24h", "7d"]) {
    const res = await page.request.get(`/api/metrics?range=${range}`)
    expect(res.status(), range).toBe(200)
    const body = await res.json()
    expect(body.range).toBe(range)
    expect(Array.isArray(body.points)).toBe(true)
    expect(body.points.length).toBeLessThanOrEqual(310)
  }
  expect((await page.request.get("/api/metrics?range=1y")).status()).toBe(400)
})

test("the dashboard chart switches between live and recorded ranges", async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page)
  const chart = page.locator('[data-slot="card"]').filter({ hasText: "Resource usage" })
  // The dashboard queries Docker for everything; slow on a busy shared host.
  await expect(chart.getByRole("combobox", { name: "Time range" })).toHaveText("Live", { timeout: 60_000 })

  await chart.getByRole("combobox", { name: "Time range" }).click()
  await page.getByRole("option", { name: "24 hours" }).click()
  await expect(chart).toContainText(/Last 24 hours|Collecting history|avg/)
})
