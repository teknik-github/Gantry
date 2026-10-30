import { expect, test, type Browser, type Page } from "@playwright/test"

import { authenticatorCode } from "../helpers/totp"
import { ADMIN } from "./credentials"

// Runs after the "login" project, which creates the ADMIN account. A
// dedicated user turns on two-factor authentication, so other suites keep
// signing in with the password alone.
test.describe.configure({ mode: "serial" })

const USER = { username: "gantry-test-k-2fa", password: "e2e-2fa-Passw0rd" }
let secret = ""
let recoveryCodes: string[] = []
let lastCode = ""

async function passwordStep(page: Page, creds: { username: string; password: string }) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(creds.username)
  await page.getByLabel("Password").fill(creds.password)
  await page.getByRole("button", { name: "Login" }).click()
}

async function signInAdmin(page: Page) {
  await passwordStep(page, ADMIN)
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function userPage(browser: Browser) {
  const context = await browser.newContext()
  return { context, page: await context.newPage() }
}

async function enterCode(page: Page, code: string) {
  await page.getByRole("textbox", { name: "Code" }).fill(code)
  await page.getByRole("button", { name: "Verify" }).click()
}

test("admin creates the user", async ({ page }) => {
  await signInAdmin(page)
  await page.goto("/users")
  await page.getByRole("button", { name: "Add user" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Username").fill(USER.username)
  await dialog.getByLabel("Password").fill(USER.password)
  await dialog.getByRole("button", { name: "Create" }).click()
  await expect(dialog).toBeHidden()
})

test("the user turns on two-factor with a code from the shown secret", async ({ browser }) => {
  const { context, page } = await userPage(browser)
  await passwordStep(page, USER)
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.goto("/account")
  await expect(page.getByTestId("2fa-status")).toHaveText("Off")
  await page.getByRole("button", { name: "Set up two-factor" }).click()
  const dialog = page.getByRole("dialog")

  // The password is checked first.
  await dialog.getByLabel("Current password").fill("not-my-password")
  await dialog.getByRole("button", { name: "Continue" }).click()
  await expect(dialog.getByText("Current password is incorrect")).toBeVisible()
  await dialog.getByLabel("Current password").fill(USER.password)
  await dialog.getByRole("button", { name: "Continue" }).click()

  await expect(dialog.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible()
  secret = (await dialog.getByTestId("totp-secret").textContent())!.trim()
  expect(secret).toMatch(/^[A-Z2-7]{32}$/)
  expect(await dialog.getByRole("link", { name: "Open in authenticator app" }).getAttribute("href")).toContain(`secret=${secret}`)

  await dialog.getByLabel("Authentication code").fill("000000")
  await dialog.getByRole("button", { name: "Turn on" }).click()
  await expect(dialog.getByText(/doesn't match/)).toBeVisible()
  await dialog.getByLabel("Authentication code").fill(authenticatorCode(secret))
  await dialog.getByRole("button", { name: "Turn on" }).click()

  const list = dialog.getByTestId("recovery-codes")
  await expect(list.getByRole("listitem")).toHaveCount(10)
  recoveryCodes = (await list.getByRole("listitem").allTextContents()).map((c) => c.trim())
  await dialog.getByRole("button", { name: "Done" }).click()
  await expect(page.getByTestId("2fa-status")).toHaveText("On")
  await expect(page.getByText("10 recovery code(s) left")).toBeVisible()
  // The secret is not sent to the browser again.
  await page.reload()
  expect(await page.content()).not.toContain(secret)
  await context.close()
})

test("login asks for a code after the password; wrong codes are refused", async ({ browser }) => {
  const { context, page } = await userPage(browser)
  await passwordStep(page, USER)
  await expect(page).toHaveURL(/\/login\/two-factor$/)
  // The password alone is not a session.
  expect((await context.cookies()).find((c) => c.name === "gantry_session")).toBeUndefined()
  expect((await page.request.get("/api/metrics")).status()).toBe(401)
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/login/)
  await page.goto("/login/two-factor")

  await enterCode(page, "123456")
  await expect(page.getByText("Invalid code")).toBeVisible()
  // The enrolment code's time step is used up; the next one (within the ±1 window) works.
  lastCode = authenticatorCode(secret, Date.now() + 30_000)
  await enterCode(page, lastCode)
  await expect(page).toHaveURL(/\/dashboard$/)
  await context.close()
})

test("a code can't be used twice", async ({ browser }) => {
  const { context, page } = await userPage(browser)
  await passwordStep(page, USER)
  await expect(page).toHaveURL(/\/login\/two-factor$/)
  // Still inside its validity window, but already used.
  await enterCode(page, lastCode)
  await expect(page.getByText("Invalid code")).toBeVisible()
  await context.close()
})

test("a recovery code signs in once", async ({ browser }) => {
  const { context, page } = await userPage(browser)
  await passwordStep(page, USER)
  await expect(page).toHaveURL(/\/login\/two-factor$/)
  await enterCode(page, recoveryCodes[0].toLowerCase())
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.goto("/account")
  await expect(page.getByText("9 recovery code(s) left")).toBeVisible()
  await context.close()

  const second = await userPage(browser)
  await passwordStep(second.page, USER)
  await enterCode(second.page, recoveryCodes[0])
  await expect(second.page.getByText("Invalid code")).toBeVisible()
  await second.context.close()
})

test("an administrator resets the user's two-factor, audited", async ({ page, browser }) => {
  await signInAdmin(page)
  await page.goto("/users")
  const row = page.getByRole("row", { name: new RegExp(USER.username) })
  await expect(row.getByText("2FA", { exact: true })).toBeVisible()
  await row.getByRole("button", { name: `Reset two-factor for ${USER.username}` }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Reset" }).click()
  await expect(row.getByText("2FA", { exact: true })).toHaveCount(0)

  await page.goto("/activity")
  await expect(page.getByRole("row", { name: /user\.reset_2fa/ }).first()).toBeVisible()

  // Password alone works again.
  const { context, page: user } = await userPage(browser)
  await passwordStep(user, USER)
  await expect(user).toHaveURL(/\/dashboard$/)
  await context.close()
})

test("clean up the user", async ({ page }) => {
  await signInAdmin(page)
  await page.goto("/users")
  await page.getByRole("row", { name: new RegExp(USER.username) }).getByRole("button", { name: "Delete user" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page.getByRole("row", { name: new RegExp(USER.username) })).toHaveCount(0)
})
