import { expect, test, type Browser, type Page } from "@playwright/test"

import { generateTlsFixtures, startTlsDockerProxy, type TlsDockerProxy, type TlsFixtures } from "../helpers/tls-docker-proxy"
import { ADMIN } from "./credentials"
import { dockerAvailable } from "./docker"

// Runs after the "login" project, which creates the ADMIN account on a fresh
// database whose only environment is "local" (id 1).
test.describe.configure({ mode: "serial" })

const VIEWER = { username: "e2e-viewer", password: "e2e-Viewer-Passw0rd" }
const NO_ENV = "No environment assigned — ask an administrator"

async function signIn(page: Page, creds: { username: string; password: string }) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(creds.username)
  await page.getByLabel("Password").fill(creds.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function viewerPage(browser: Browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signIn(page, VIEWER)
  return { context, page }
}

test("admin creates a standard user, who starts without environments", async ({ page }) => {
  await signIn(page, ADMIN)
  await page.goto("/users")
  await page.getByRole("button", { name: "Add user" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Username").fill(VIEWER.username)
  await dialog.getByLabel("Password").fill(VIEWER.password)
  await dialog.getByRole("button", { name: "Create" }).click()
  await expect(dialog).toBeHidden()

  await expect(page.getByTestId(`user-envs-${VIEWER.username}`)).toHaveText("None")
  await expect(page.getByTestId(`user-envs-${ADMIN.username}`)).toHaveText("All")
})

test("a user without grants sees an empty state and can't pick an environment", async ({ browser, baseURL }) => {
  const { context, page } = await viewerPage(browser)

  await expect(page.getByTestId("no-environment")).toContainText(NO_ENV)
  await expect(page.getByRole("heading", { name: "Dashboard", level: 2 })).toBeVisible()
  await page.goto("/containers")
  await expect(page.getByTestId("no-environment")).toContainText(NO_ENV)

  // The switcher offers nothing.
  await page.locator('[data-sidebar="header"]').getByRole("button").first().click()
  await expect(page.getByRole("menuitem", { name: /None assigned/ })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: /local/ })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: "Manage environments" })).toHaveCount(0)
  await page.keyboard.press("Escape")

  // Forcing the environment cookie doesn't help: access is checked on the server.
  await context.addCookies([{ name: "gantry_env", value: "1", url: baseURL! }])
  await page.goto("/dashboard")
  await expect(page.getByTestId("no-environment")).toContainText(NO_ENV)
  const stats = await page.request.get("/api/stats")
  expect(stats.ok()).toBe(false)
  expect((await stats.json()).error).toBe(NO_ENV)

  await context.close()
})

test("admin grants access and the user can use the environment", async ({ page, browser }) => {
  await signIn(page, ADMIN)
  await page.goto("/users")
  await page.getByRole("button", { name: `Environment access for ${VIEWER.username}` }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("checkbox", { name: "local" }).check()
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId(`user-envs-${VIEWER.username}`)).toHaveText("local")

  // The environments page shows who has access.
  await page.goto("/environments")
  await expect(page.getByTestId("env-access-local")).toHaveText(VIEWER.username)

  const { context, page: viewer } = await viewerPage(browser)
  await expect(viewer.getByRole("heading", { name: "Environment: local" })).toBeVisible()
  await expect(viewer.getByTestId("no-environment")).toHaveCount(0)
  await expect(viewer.locator('[data-sidebar="header"]')).toContainText("local")
  await context.close()
})

test.describe("TLS environments", () => {
  let fx: TlsFixtures
  let proxy: TlsDockerProxy
  const NAME = "gantry-test-b-tls"

  test.beforeAll(async () => {
    test.skip(!(await dockerAvailable()), "Docker socket not available")
    fx = generateTlsFixtures()
    proxy = await startTlsDockerProxy({ ca: fx.ca, cert: fx.server.cert, key: fx.server.key })
  })

  test.afterAll(async () => {
    await proxy?.close()
    fx?.cleanup()
  })

  test("admin adds, edits and removes a TLS environment; the key never comes back", async ({ page }) => {
    await signIn(page, ADMIN)
    await page.goto("/environments")

    await page.getByRole("button", { name: "Add environment" }).click()
    const dialog = page.getByRole("dialog")
    await dialog.getByLabel("Name").fill(NAME)
    await dialog.getByLabel("Host and port").fill(proxy.address)
    await dialog.getByRole("switch", { name: "Use TLS" }).click()
    await dialog.getByLabel("CA certificate", { exact: true }).fill(fx.ca)
    await dialog.getByLabel("Client certificate", { exact: true }).fill(fx.client.cert)
    await dialog.getByLabel("Client key", { exact: true }).fill(fx.client.key)
    await dialog.getByRole("button", { name: "Connect" }).click()
    await expect(dialog).toBeHidden()

    const row = page.getByRole("row", { name: new RegExp(NAME) })
    await expect(row).toContainText("up · Docker")
    await expect(row).toContainText("TLS")
    await expect(page.getByTestId(`env-access-${NAME}`)).toHaveText("Admins only")
    const keyLine = fx.client.key.split("\n")[1]
    expect(await page.content()).not.toContain(keyLine)

    // Editing keeps the stored certificates without showing them.
    await row.getByRole("button", { name: "Edit environment" }).click()
    await expect(dialog.getByText("TLS configured")).toBeVisible()
    await expect(dialog.locator("textarea")).toHaveCount(0)
    await dialog.getByLabel("Name").fill(`${NAME}-2`)
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog).toBeHidden()
    const renamed = page.getByRole("row", { name: new RegExp(`${NAME}-2`) })
    await expect(renamed).toContainText("up · Docker")

    // Replacing them with a CA that didn't sign the daemon fails the connection test.
    await renamed.getByRole("button", { name: "Edit environment" }).click()
    await dialog.getByRole("button", { name: "Replace" }).click()
    await dialog.getByLabel("CA certificate", { exact: true }).fill(fx.rogueCa)
    await dialog.getByLabel("Client certificate", { exact: true }).fill(fx.client.cert)
    await dialog.getByLabel("Client key", { exact: true }).fill(fx.client.key)
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog.getByText(/Could not connect: TLS handshake/)).toBeVisible()
    await dialog.getByRole("button", { name: "Cancel" }).click()

    // Turning TLS off is refused too: the endpoint only speaks TLS.
    await renamed.getByRole("button", { name: "Edit environment" }).click()
    await dialog.getByRole("switch", { name: "Use TLS" }).click()
    await expect(dialog.getByText("The stored TLS certificates will be removed")).toBeVisible()
    await dialog.getByRole("button", { name: "Save" }).click()
    await expect(dialog.getByText(/Could not connect/)).toBeVisible()
    await dialog.getByRole("button", { name: "Cancel" }).click()

    await renamed.getByRole("button", { name: "Remove environment" }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
    await expect(renamed).toHaveCount(0)
  })
})
