import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable, removeContainer, startScratchContainer } from "./docker"

// Runs after the "login" project, which creates the ADMIN account.
// Checklists on the list pages: select several objects, act on all of them.
test.describe.configure({ mode: "serial" })

const PREFIX = "gantry-test-f-bulk"
const CONTAINERS = [`${PREFIX}-c1`, `${PREFIX}-c2`]
const VOLUMES = [`${PREFIX}-v1`, `${PREFIX}-v2`]
const NETWORKS = [`${PREFIX}-n1`, `${PREFIX}-n2`]
const IMAGE = `${PREFIX}-img`
const LABELS = { "gantry.e2e": "true" }

// Docker on a busy shared host can be slow.
const TIMEOUT = 240_000
const timeout = 45_000

async function cleanup() {
  for (const name of [...CONTAINERS, `${PREFIX}-src`]) await removeContainer(name)
  for (const tag of ["a", "b"]) await docker("DELETE", `/images/${IMAGE}:${tag}?force=true`).catch(() => {})
  for (const v of VOLUMES) await docker("DELETE", `/volumes/${v}`).catch(() => {})
  for (const n of NETWORKS) await docker("DELETE", `/networks/${n}`).catch(() => {})
}

test.beforeAll(async () => {
  test.setTimeout(TIMEOUT)
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  await cleanup()
})

test.afterAll(async () => {
  test.setTimeout(TIMEOUT)
  await cleanup()
})

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function search(page: Page, text: string) {
  await page.getByLabel("Search").fill(text)
}

test("containers: select all, stop, start and remove in bulk", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  for (const name of CONTAINERS) await startScratchContainer(name)
  await signIn(page)
  await page.goto("/containers")
  await search(page, PREFIX)
  const rows = page.getByRole("row").filter({ hasText: PREFIX })
  await expect(rows).toHaveCount(2)

  const bar = page.getByTestId("bulk-bar")
  await expect(bar).toBeHidden()
  await page.getByLabel("Select all").click()
  await expect(bar).toContainText("2 selected")
  // Start doesn't apply to running containers.
  await expect(bar.getByRole("button", { name: "Start", exact: true })).toBeDisabled()

  await bar.getByRole("button", { name: /^Stop/ }).click()
  await expect(page.getByText("Stopped 2 containers")).toBeVisible({ timeout })
  await expect(bar).toBeHidden()
  for (const name of CONTAINERS) await expect(rows.filter({ hasText: name })).toContainText(/exited/i, { timeout })

  // One checkbox at a time this time.
  for (const name of CONTAINERS) await page.getByLabel(`Select ${name}`).click()
  await expect(bar).toContainText("2 selected")
  await bar.getByRole("button", { name: /^Start/ }).click()
  await expect(page.getByText("Started 2 containers")).toBeVisible({ timeout })
  for (const name of CONTAINERS) await expect(rows.filter({ hasText: name })).toContainText(/running/i, { timeout })

  // Removing running containers without force fails and says why; nothing is removed.
  await page.getByLabel("Select all").click()
  await bar.getByRole("button", { name: /^Remove/ }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(dialog.getByTestId("bulk-names")).toContainText(CONTAINERS[0])
  await expect(dialog).toContainText("2 of them are running")
  await dialog.getByRole("button", { name: "Remove" }).click()
  await expect(page.getByText(/Removed 0 of 2 containers\. Failed:/)).toBeVisible({ timeout })
  // The dialog stays open (the page behind it is aria-hidden); ask Docker instead.
  for (const name of CONTAINERS) await docker("GET", `/containers/${name}/json`)

  await dialog.getByLabel("Force (stop running ones first)").click()
  await dialog.getByRole("button", { name: "Remove" }).click()
  await expect(page.getByText("Removed 2 containers")).toBeVisible({ timeout })
  await expect(dialog).toBeHidden()
  await expect(rows).toHaveCount(0, { timeout })
})

test("volumes: bulk remove", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  for (const v of VOLUMES) await docker("POST", "/volumes/create", { Name: v, Labels: LABELS })
  await signIn(page)
  await page.goto("/volumes")
  await search(page, PREFIX)
  await expect(page.getByRole("row").filter({ hasText: PREFIX })).toHaveCount(2)

  await page.getByLabel("Select all").click()
  const bar = page.getByTestId("bulk-bar")
  await expect(bar).toContainText("2 selected")
  await bar.getByRole("button", { name: /^Remove/ }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await expect(page.getByText("Removed 2 volumes")).toBeVisible({ timeout })
  await expect(page.getByRole("row").filter({ hasText: PREFIX })).toHaveCount(0, { timeout })
})

test("networks: built-in networks can't be selected; bulk remove works", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  for (const n of NETWORKS) await docker("POST", "/networks/create", { Name: n, Labels: LABELS })
  await signIn(page)
  await page.goto("/networks")
  await expect(page.getByLabel("Select bridge")).toHaveCount(0)
  await expect(page.getByLabel(`Select ${NETWORKS[0]}`)).toBeVisible()

  await search(page, PREFIX)
  await page.getByLabel("Select all").click()
  const bar = page.getByTestId("bulk-bar")
  await expect(bar).toContainText("2 selected")
  await bar.getByRole("button", { name: /^Remove/ }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await expect(page.getByText("Removed 2 networks")).toBeVisible({ timeout })
  await expect(page.getByRole("row").filter({ hasText: PREFIX })).toHaveCount(0, { timeout })
})

test("images: bulk remove", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  // Two throwaway images (distinct ids) committed from a scratch container.
  await startScratchContainer(`${PREFIX}-src`)
  for (const tag of ["a", "b"]) await docker("POST", `/commit?container=${PREFIX}-src&repo=${IMAGE}&tag=${tag}&comment=${tag}`)
  await removeContainer(`${PREFIX}-src`)

  await signIn(page)
  await page.goto("/images")
  await search(page, IMAGE)
  await expect(page.getByRole("row").filter({ hasText: IMAGE })).toHaveCount(2)

  await page.getByLabel("Select all").click()
  const bar = page.getByTestId("bulk-bar")
  await bar.getByRole("button", { name: /^Remove/ }).click()
  await expect(page.getByRole("alertdialog").getByTestId("bulk-names")).toContainText(`${IMAGE}:a`)
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await expect(page.getByText("Removed 2 images")).toBeVisible({ timeout })
  await expect(page.getByRole("row").filter({ hasText: IMAGE })).toHaveCount(0, { timeout })
})
