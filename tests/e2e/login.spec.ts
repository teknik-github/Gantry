import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"

// The suite starts from an empty database (see playwright.config.ts), so the
// tests run in order: first-run setup, then login/logout behaviour.
test.describe.configure({ mode: "serial" })

const SESSION_COOKIE = "gantry_session"

async function login(page: Page, username: string, password: string) {
  await page.getByLabel("Username").fill(username)
  await page.getByLabel("Password").fill(password)
  // Wait for the Server Action round trip so the next attempt doesn't race
  // React's post-action form reset.
  await Promise.all([
    page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/login"),
    page.getByRole("button", { name: "Login" }).click(),
  ])
}

async function logout(page: Page) {
  await page.locator('[data-sidebar="footer"]').getByRole("button").click()
  await page.getByRole("menuitem", { name: "Log out" }).click()
  await expect(page).toHaveURL(/\/login$/)
}

async function sessionCookie(page: Page) {
  return (await page.context().cookies()).find((c) => c.name === SESSION_COOKIE)
}

test("fresh install sends visitors to the admin setup", async ({ page }) => {
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByRole("heading", { name: "Welcome to Gantry" })).toBeVisible()
})

test("API is not reachable without a session", async ({ request }) => {
  for (const path of ["/api/stats", "/api/containers/0123456789ab/logs", "/api/does-not-exist"]) {
    const res = await request.get(path)
    expect(res.status(), path).toBe(401)
    expect(await res.json()).toEqual({ error: "Unauthorized" })
  }
  // Only the healthcheck is public.
  expect((await request.get("/api/health")).status()).toBe(200)
})

test("setup validates input and keeps what was typed", async ({ page }) => {
  await page.goto("/setup")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password)
  await page.getByLabel("Confirm password").fill("something-else")
  await page.getByRole("button", { name: "Create administrator" }).click()

  await expect(page.getByText("Passwords do not match")).toBeVisible()
  await expect(page.getByLabel("Username")).toHaveValue(ADMIN.username)
  await expect(page).toHaveURL(/\/setup$/)
})

test("setup creates the administrator and signs them in", async ({ page }) => {
  await page.goto("/setup")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password)
  await page.getByLabel("Confirm password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Create administrator" }).click()

  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.locator('[data-sidebar="footer"]')).toContainText(ADMIN.username)
})

test("setup is closed once an administrator exists", async ({ page }) => {
  await page.goto("/setup")
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole("heading", { name: "Login to Gantry" })).toBeVisible()
})

test("wrong password is rejected without creating a session", async ({ page }) => {
  await page.goto("/login")
  await login(page, ADMIN.username, "not-the-password")

  await expect(page.getByText("Invalid username or password")).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByLabel("Username")).toHaveValue(ADMIN.username)
  expect(await sessionCookie(page)).toBeUndefined()
})

test("unknown user gets the same error as a wrong password", async ({ page }) => {
  await page.goto("/login")
  await login(page, "nobody-here", "whatever-password")
  await expect(page.getByText("Invalid username or password")).toBeVisible()
})

test("valid login sets a hardened session cookie and opens the dashboard", async ({ page }) => {
  await page.goto("/login")
  await login(page, ADMIN.username, ADMIN.password)

  await expect(page).toHaveURL(/\/dashboard$/)
  const cookie = await sessionCookie(page)
  expect(cookie).toBeDefined()
  expect(cookie!.httpOnly).toBe(true)
  expect(cookie!.sameSite).toBe("Lax")

  // The same browser session can now use the API.
  const res = await page.request.get("/api/stats")
  expect(res.status()).not.toBe(401)
})

test("signed-in users are sent away from the login page", async ({ page }) => {
  await page.goto("/login")
  await login(page, ADMIN.username, ADMIN.password)
  await expect(page).toHaveURL(/\/dashboard$/)

  await page.goto("/login")
  await expect(page).toHaveURL(/\/dashboard$/)
})

test("logout clears the session and locks the API again", async ({ page }) => {
  await page.goto("/login")
  await login(page, ADMIN.username, ADMIN.password)
  await expect(page).toHaveURL(/\/dashboard$/)

  await logout(page)
  expect(await sessionCookie(page)).toBeUndefined()
  expect((await page.request.get("/api/stats")).status()).toBe(401)

  await page.goto("/containers")
  await expect(page).toHaveURL(/\/login\?next=%2Fcontainers$/)
})

test("login returns to the page that was requested", async ({ page }) => {
  await page.goto("/images")
  await expect(page).toHaveURL(/\/login\?next=%2Fimages$/)

  await login(page, ADMIN.username, ADMIN.password)
  await expect(page).toHaveURL(/\/images$/)
})

test("next= cannot redirect to another site", async ({ page }) => {
  await page.goto("/login?next=//evil.example.com/phish")
  await login(page, ADMIN.username, ADMIN.password)
  await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/dashboard$/)
})

test("a forged session cookie is rejected and removed", async ({ page, context, baseURL }) => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify({ sub: "1", role: "admin", iss: "gantry", exp: 4102444800 })).toString("base64url")
  await context.addCookies([{ name: SESSION_COOKIE, value: `${header}.${payload}.forged`, url: baseURL! }])

  expect((await page.request.get("/api/stats")).status()).toBe(401)
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/login$/)
  expect(await sessionCookie(page)).toBeUndefined()
})

test("login works before hydration and never leaks credentials into a URL", async ({ page }) => {
  // Block the app's JS so the form is submitted the way a fast click before
  // hydration would be: it must still be a POST to the Server Action.
  await page.route("**/_next/static/chunks/**/*.js", (route) => route.abort())
  const documents: { method: string; url: string }[] = []
  page.on("request", (req) => {
    if (req.resourceType() === "document") documents.push({ method: req.method(), url: req.url() })
  })

  await page.goto("/login")
  await login(page, ADMIN.username, "wrong-password-123")
  await expect(page).toHaveURL(/\/login$/)
  expect(await sessionCookie(page)).toBeUndefined()

  await page.goto("/login")
  await login(page, ADMIN.username, ADMIN.password)
  await expect(page).toHaveURL(/\/dashboard$/)

  const submits = documents.filter((d) => d.url.endsWith("/login") && d.method === "POST")
  expect(submits).toHaveLength(2)
  expect(documents.filter((d) => /password|username=/.test(d.url))).toEqual([])
})

test("repeated failures are rate limited", async ({ page }) => {
  // A dedicated username so the lockout doesn't affect the admin account.
  const user = "ratelimit-probe"
  await page.goto("/login")
  for (let i = 0; i < 5; i++) {
    await login(page, user, `wrong-${i}`)
    await expect(page.getByText("Invalid username or password")).toBeVisible()
    await expect(page.getByLabel("Password")).toHaveValue("")
  }
  await login(page, user, "wrong-again")
  await expect(page.getByText(/Too many attempts\. Try again in \d+s\./)).toBeVisible()
})
