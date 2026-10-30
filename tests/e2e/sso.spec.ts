import { expect, test, type Browser, type Page } from "@playwright/test"

import { startFakeOidc, type FakeOidc } from "../helpers/fake-oidc"
import { ADMIN } from "./credentials"

// Runs after the "login" project, which creates the ADMIN account. Single
// sign-on against a fake OpenID provider started here on the port the web
// server was configured with (playwright.config.ts).
test.describe.configure({ mode: "serial" })

// Same default as playwright.config.ts.
const OIDC_PORT = Number(process.env.E2E_OIDC_PORT ?? Number(process.env.E2E_PORT ?? 3100) + 1)
const PREFIX = "gantry-test-k-sso"
const LOCAL = { username: `${PREFIX}-local`, password: "e2e-Sso-Passw0rd" }
let idp: FakeOidc

test.beforeAll(async () => {
  test.skip(Boolean(process.env.E2E_BASE_URL), "needs the web server started by playwright.config.ts")
  idp = await startFakeOidc({ port: OIDC_PORT, clientId: "gantry-e2e", clientSecret: "gantry-e2e-oidc-secret" })
})

test.afterAll(async () => {
  await idp?.close()
})

async function signIn(page: Page, creds: { username: string; password: string }) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(creds.username)
  await page.getByLabel("Password").fill(creds.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function ssoSignIn(browser: Browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto("/login")
  await page.getByRole("link", { name: "Sign in with SSO" }).click()
  return { context, page }
}

const footer = (page: Page) => page.locator('[data-sidebar="footer"]')

test("the first SSO login creates a standard user", async ({ browser }) => {
  idp.setUser({ sub: "e2e-sub-1", claims: { preferred_username: PREFIX, email: `${PREFIX}@example.com` } })
  const { context, page } = await ssoSignIn(browser)
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(footer(page)).toContainText(PREFIX)
  await expect(page.getByRole("link", { name: "Users" })).toHaveCount(0)

  // Authorization code flow with PKCE, state and nonce.
  const req = idp.requests.at(-1)!
  expect(req.get("response_type")).toBe("code")
  expect(req.get("code_challenge_method")).toBe("S256")
  expect(req.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(req.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(req.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(req.get("redirect_uri")).toMatch(/\/auth\/oidc\/callback$/)
  // The flow's state cookie is gone; a session exists.
  const cookies = await context.cookies()
  expect(cookies.find((c) => c.name === "gantry_oidc")).toBeUndefined()
  expect(cookies.find((c) => c.name === "gantry_session")?.httpOnly).toBe(true)

  // SSO users have no password to change or 2FA to set up.
  await page.goto("/account")
  await expect(page.getByText("Change password")).toHaveCount(0)
  await expect(page.getByText("Linked to")).toBeVisible()
  await context.close()
})

test("members of the admin group become administrators", async ({ browser }) => {
  idp.setUser({ sub: "e2e-sub-admin", claims: { preferred_username: `${PREFIX}-admin`, groups: ["staff", "gantry-admins"] } })
  const { context, page } = await ssoSignIn(browser)
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(footer(page)).toContainText(`${PREFIX}-admin`)
  await expect(page.getByRole("link", { name: "Users" })).toBeVisible()
  await context.close()
})

test("an existing local user is never matched by name; they link their account themselves", async ({ page, browser }) => {
  await signIn(page, ADMIN)
  await page.goto("/users")
  await page.getByRole("button", { name: "Add user" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Username").fill(LOCAL.username)
  await dialog.getByLabel("Password").fill(LOCAL.password)
  await dialog.getByRole("button", { name: "Create" }).click()
  await expect(dialog).toBeHidden()

  // An identity claiming the same username gets its own account.
  idp.setUser({ sub: "e2e-sub-impostor", claims: { preferred_username: LOCAL.username } })
  const impostor = await ssoSignIn(browser)
  await expect(impostor.page).toHaveURL(/\/dashboard$/)
  await expect(footer(impostor.page)).toContainText(`${LOCAL.username}-2`)
  await impostor.context.close()

  // The local user links their own identity from the Account page.
  const context = await browser.newContext()
  const local = await context.newPage()
  await signIn(local, LOCAL)
  await local.goto("/account")
  idp.setUser({ sub: "e2e-sub-local", claims: { preferred_username: "whatever" } })
  await local.getByRole("button", { name: "Link SSO account" }).click()
  await expect(local).toHaveURL(/\/account\?sso=linked$/)
  await expect(local.getByTestId("sso-message")).toContainText("now linked")
  await context.close()

  const sso = await ssoSignIn(browser)
  await expect(sso.page).toHaveURL(/\/dashboard$/)
  await expect(footer(sso.page)).toContainText(LOCAL.username)
  await expect(footer(sso.page)).not.toContainText(`${LOCAL.username}-2`)
  await sso.context.close()
})

test("a callback without the matching state is refused", async ({ page }) => {
  await page.goto("/auth/oidc/callback?code=stolen&state=forged")
  await expect(page).toHaveURL(/\/login\?sso=expired$/)
  // Not Next's route announcer (also role="alert"): the message itself.
  await expect(page.getByRole("alert").filter({ hasText: "expired" })).toBeVisible()
})

test("clean up the SSO users", async ({ page }) => {
  await signIn(page, ADMIN)
  for (const name of [PREFIX, `${PREFIX}-admin`, LOCAL.username, `${LOCAL.username}-2`]) {
    await page.goto("/users")
    const row = page.getByRole("row", { name: new RegExp(`^${name} `) })
    await row.getByRole("button", { name: "Delete user" }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
    await expect(row).toHaveCount(0)
  }
})
