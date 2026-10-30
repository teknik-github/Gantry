import { expect, test, type Browser, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { dockerAvailable, removeContainer, startScratchContainer } from "./docker"

// Runs after the "login" project, which creates the ADMIN account on a fresh
// database whose only environment is "local". Standard users with the
// viewer, operator and manager role on it: what they see, and what the
// server refuses even when the page still offers it (role lowered while the
// page was open).
test.describe.configure({ mode: "serial" })

const PREFIX = "gantry-test-k-role"
const USERS = {
  viewer: { username: `${PREFIX}-viewer`, password: "e2e-Role-Passw0rd" },
  operator: { username: `${PREFIX}-operator`, password: "e2e-Role-Passw0rd" },
  manager: { username: `${PREFIX}-manager`, password: "e2e-Role-Passw0rd" },
}
const CONTAINER = `${PREFIX}-c1`
const DISPOSABLE = `${PREFIX}-c2`
const VOLUME = `${PREFIX}-vol`
const TIMEOUT = 180_000
const timeout = 45_000
let containerId = ""
let disposableId = ""

async function signIn(page: Page, creds: { username: string; password: string }) {
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

/** Admin: grants `username` the role on "local" (or removes access with null). */
async function grant(page: Page, username: string, role: "Viewer" | "Operator" | "Manager" | null) {
  await page.goto("/users")
  await page.getByRole("button", { name: `Environment access for ${username}` }).click()
  const dialog = page.getByRole("dialog")
  const box = dialog.getByRole("checkbox", { name: "local" })
  if (role === null) {
    await box.uncheck()
  } else {
    await box.check()
    await dialog.getByRole("combobox", { name: "Role for local" }).click()
    await page.getByRole("option", { name: role, exact: true }).click()
  }
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId(`user-envs-${username}`)).toHaveText(role ? `local ${role.toLowerCase()}` : "None")
}

async function cleanup() {
  await removeContainer(CONTAINER)
  await removeContainer(DISPOSABLE)
}

test.beforeAll(async () => {
  test.setTimeout(TIMEOUT)
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  await cleanup()
  containerId = await startScratchContainer(CONTAINER)
  disposableId = await startScratchContainer(DISPOSABLE)
})

test.afterAll(async () => {
  test.setTimeout(TIMEOUT)
  await cleanup()
})

test("admin creates the users and grants a role each", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page, ADMIN)
  for (const creds of Object.values(USERS)) {
    await page.goto("/users")
    await page.getByRole("button", { name: "Add user" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Username").fill(creds.username)
    await dialog.getByLabel("Password").fill(creds.password)
    await dialog.getByRole("button", { name: "Create" }).click()
    await expect(dialog).toBeHidden()
  }
  await grant(page, USERS.viewer.username, "Viewer")
  await grant(page, USERS.operator.username, "Operator")
  await grant(page, USERS.manager.username, "Manager")

  await page.goto("/environments")
  const access = page.getByTestId("env-access-local")
  await expect(access).toContainText(`${USERS.viewer.username} viewer`)
  await expect(access).toContainText(`${USERS.manager.username} manager`)
})

test("a viewer can look but not touch", async ({ browser }) => {
  test.setTimeout(TIMEOUT)
  const { context, page } = await as(browser, USERS.viewer)
  await page.goto("/containers")
  await page.getByLabel("Search").fill(CONTAINER)
  const row = page.getByRole("row").filter({ hasText: CONTAINER })
  await expect(row).toHaveCount(1, { timeout })
  // No selection checkboxes, no lifecycle items, no create button.
  await expect(page.getByRole("checkbox")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Add container" })).toHaveCount(0)
  await row.getByRole("button", { name: "Open menu" }).click()
  await expect(page.getByRole("menuitem", { name: "Details" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Stop" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  await page.goto(`/containers/${containerId}`)
  await expect(page.getByTestId("logs-hidden")).toBeVisible({ timeout })
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0)
  await expect(page.getByRole("tab", { name: "Console" })).toHaveCount(0)

  // The server agrees: logs need the operator role; the dashboard data is readable.
  const logs = await page.request.get(`/api/containers/${containerId}/logs`)
  expect(logs.status()).toBe(403)
  expect((await logs.json()).error).toMatch(/operator role/)
  expect((await page.request.get("/api/metrics")).status()).toBe(200)

  // Environment settings and administration stay out of reach.
  await expect(page.getByRole("link", { name: "Proxy" })).toHaveCount(0)
  await page.goto("/proxy")
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.goto("/users")
  await expect(page).toHaveURL(/\/dashboard$/)
  await context.close()
})

test("an operator can stop and start but not remove; the server re-checks the role", async ({ page, browser }) => {
  test.setTimeout(TIMEOUT)
  const { context, page: op } = await as(browser, USERS.operator)
  await op.goto(`/containers/${containerId}`)
  await expect(op.getByRole("button", { name: "Stop", exact: true })).toBeVisible({ timeout })
  await expect(op.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0)
  await expect(op.getByRole("tab", { name: "Console" })).toHaveCount(0)
  await expect(op.getByTestId("logs-hidden")).toHaveCount(0)
  expect((await op.request.get(`/api/containers/${containerId}/logs`)).status()).toBe(200)

  await op.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(op.getByText(`${CONTAINER}: stopped`)).toBeVisible({ timeout })
  await expect(op.getByRole("button", { name: "Start", exact: true })).toBeVisible({ timeout })

  // The admin lowers the operator to viewer while their page is still open...
  await signIn(page, ADMIN)
  await grant(page, USERS.operator.username, "Viewer")
  // ...so the Start button they still see is refused by the server.
  await op.getByRole("button", { name: "Start", exact: true }).click()
  await expect(op.getByText("This needs the operator role in local.")).toBeVisible({ timeout })
  await op.reload()
  await expect(op.getByRole("button", { name: "Start", exact: true })).toHaveCount(0)

  await grant(page, USERS.operator.username, "Operator")
  await context.close()
})

test("a manager has full control of the environment, but no administration", async ({ page, browser }) => {
  test.setTimeout(TIMEOUT)
  const { context, page: mgr } = await as(browser, USERS.manager)
  // Environment-level settings appear in the sidebar; administration doesn't.
  await expect(mgr.getByRole("link", { name: "Proxy" })).toBeVisible()
  await expect(mgr.getByRole("link", { name: "Auto-update" })).toBeVisible()
  await expect(mgr.getByRole("link", { name: "Users" })).toHaveCount(0)
  await mgr.goto("/proxy")
  await expect(mgr.getByRole("heading", { name: "Proxy", exact: true })).toBeVisible({ timeout })
  await mgr.goto("/auto-update")
  // The global schedule is for administrators.
  await expect(mgr.getByText(`Containers on local`)).toBeVisible({ timeout })
  await expect(mgr.getByRole("button", { name: "Run now" })).toHaveCount(0)
  await mgr.goto("/users")
  await expect(mgr).toHaveURL(/\/dashboard$/)

  await mgr.goto(`/containers/${disposableId}`)
  await expect(mgr.getByRole("tab", { name: "Console" })).toBeVisible({ timeout })
  await mgr.getByRole("button", { name: "Remove", exact: true }).click()
  await mgr.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }).click()
  await expect(mgr).toHaveURL(/\/containers$/, { timeout })

  // Lowered to operator with the volumes page open: creating is refused.
  await mgr.goto("/volumes")
  await signIn(page, ADMIN)
  await grant(page, USERS.manager.username, "Operator")
  await mgr.getByRole("button", { name: "Add volume" }).click()
  const dialog = mgr.getByRole("dialog")
  await dialog.getByLabel("Name").fill(VOLUME)
  await dialog.getByRole("button", { name: "Create" }).click()
  await expect(dialog.getByText("This needs the manager role in local.")).toBeVisible({ timeout })
  await context.close()
})

test("clean up the users", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page, ADMIN)
  for (const creds of Object.values(USERS)) {
    await page.goto("/users")
    await page.getByRole("row", { name: new RegExp(creds.username) }).getByRole("button", { name: "Delete user" }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
    await expect(page.getByRole("row", { name: new RegExp(creds.username) })).toHaveCount(0)
  }
})
