import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { dockerAvailable } from "./docker"

// Runs after the "login" project, which creates the ADMIN account. Personal
// API tokens: created on the Account page, shown once, usable as a bearer
// token on /api/* only, and dead once revoked.
test.describe.configure({ mode: "serial" })

const NAME = "gantry-test-k-token"
let token = ""

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

const bearer = (value = token) => ({ Authorization: `Bearer ${value}` })

test("create a token; it is shown once", async ({ page }) => {
  await signIn(page)
  await page.goto("/account")
  await page.getByRole("button", { name: "New token" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name").fill(NAME)
  await dialog.getByRole("combobox", { name: "Expires" }).click()
  await page.getByRole("option", { name: "In 30 days" }).click()
  await dialog.getByRole("button", { name: "Create token" }).click()
  token = (await dialog.getByTestId("new-token").textContent())!.trim()
  expect(token).toMatch(/^gtk_[A-Za-z0-9_-]{43}$/)
  await dialog.getByRole("button", { name: "Done" }).click()

  const row = page.getByRole("row", { name: new RegExp(NAME) })
  await expect(row).toContainText(token.slice(0, 10))
  await expect(row).toContainText("never") // not used yet
  // Only the prefix comes back.
  await page.reload()
  expect(await page.content()).not.toContain(token)
})

test("the token works for /api/* like the user", async ({ playwright, baseURL }) => {
  // A client with no cookies at all, like curl.
  const api = await playwright.request.newContext({ baseURL })
  const metrics = await api.get("/api/metrics?range=1h", { headers: bearer() })
  expect(metrics.status()).toBe(200)
  expect((await metrics.json()).range).toBe("1h")

  if (await dockerAvailable()) {
    const res = await api.get("/api/v1/containers", { headers: bearer() })
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.environment.name).toBe("local")
    expect(Array.isArray(body.containers)).toBe(true)
    // Picking an environment that doesn't exist is refused, not silently replaced.
    const other = await api.get("/api/v1/containers", { headers: { ...bearer(), "X-Gantry-Environment": "999999" } })
    expect(other.ok()).toBe(false)
  }

  // Wrong or malformed tokens get nothing.
  expect((await api.get("/api/metrics", { headers: bearer(`gtk_${"A".repeat(43)}`) })).status()).toBe(401)
  expect((await api.get("/api/metrics", { headers: bearer("not-a-token") })).status()).toBe(401)
  // Interactive endpoints are browser-only.
  expect((await api.get("/api/exec/whatever", { headers: bearer() })).status()).toBe(403)
  await api.dispose()
})

test("the token never opens pages or Server Actions", async ({ playwright, baseURL }) => {
  const api = await playwright.request.newContext({ baseURL })
  for (const path of ["/dashboard", "/account", "/users"]) {
    const res = await api.get(path, { headers: bearer(), maxRedirects: 0 })
    expect(res.status(), path).toBeGreaterThanOrEqual(300)
    expect(res.status(), path).toBeLessThan(400)
    expect(res.headers().location, path).toMatch(/\/login/)
  }
  // A Server Action POST carrying the token is treated as anonymous.
  const action = await api.post("/account", {
    headers: { ...bearer(), "Next-Action": "0".repeat(42), "Content-Type": "text/plain;charset=UTF-8" },
    data: "[]",
    maxRedirects: 0,
  })
  expect(action.status()).toBeGreaterThanOrEqual(300)
  expect(action.status()).toBeLessThan(400)
  expect(action.headers().location).toMatch(/\/login/)
  // Smuggling the internal marker header doesn't help either.
  const forged = await api.get("/dashboard", { headers: { ...bearer(), "x-gantry-api-auth": "1" }, maxRedirects: 0 })
  expect(forged.headers().location).toMatch(/\/login/)
  await api.dispose()
})

test("revoking the token locks it out", async ({ page, playwright, baseURL }) => {
  await signIn(page)
  await page.goto("/account")
  const row = page.getByRole("row", { name: new RegExp(NAME) })
  await expect(row).not.toContainText("never") // last used is recorded
  await row.getByRole("button", { name: `Revoke ${NAME}` }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke" }).click()
  // The dialog closes once the action has returned. Until then it hides the
  // page from the accessibility tree, so the row "disappears" early.
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
  await expect(row).toHaveCount(0)

  const api = await playwright.request.newContext({ baseURL })
  const res = await api.get("/api/metrics", { headers: bearer() })
  expect(res.status()).toBe(401)
  await api.dispose()
})
