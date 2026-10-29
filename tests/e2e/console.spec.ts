import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { dockerAvailable, removeContainer, startScratchContainer } from "./docker"

// Runs after the "login" project, which creates the ADMIN account.
test.describe.configure({ mode: "serial" })

let containerId = ""

test.beforeAll(async () => {
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  containerId = await startScratchContainer(`gantry-e2e-exec-${Date.now()}`)
})

test.afterAll(async () => {
  if (containerId) await removeContainer(containerId)
})

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

const terminal = (page: Page) => page.getByTestId("exec-terminal").locator(".xterm-rows")

async function typeLine(page: Page, line: string) {
  await page.getByTestId("exec-terminal").click()
  await page.keyboard.type(line)
  await page.keyboard.press("Enter")
}

test("admin can run commands in a container console", async ({ page }) => {
  await signIn(page)
  await page.goto(`/containers/${containerId}?tab=console`)
  await expect(page.getByRole("tab", { name: "Console" })).toHaveAttribute("aria-selected", "true")

  await page.getByRole("button", { name: "Connect" }).click()
  await expect(page.getByText("Connected", { exact: true })).toBeVisible()

  // Computed by the shell, so the text only appears if input reached it.
  await typeLine(page, "echo gantry-$((40 + 2))")
  await expect(terminal(page)).toContainText("gantry-42")

  // The TTY size is passed through to the container.
  await typeLine(page, "stty size")
  await expect(terminal(page)).toContainText(/\n?\d{1,3} \d{2,3}/)

  await typeLine(page, "exit 3")
  await expect(terminal(page)).toContainText("[process exited with code 3]")
  await expect(page.getByRole("button", { name: "Reconnect" })).toBeVisible()
})

test("console survives switching to the logs tab", async ({ page }) => {
  await signIn(page)
  await page.goto(`/containers/${containerId}?tab=console`)
  await page.getByRole("button", { name: "Connect" }).click()
  await expect(page.getByText("Connected", { exact: true })).toBeVisible()
  await typeLine(page, "export MARK=still-here")

  await page.getByRole("tab", { name: "Logs" }).click()
  await page.getByRole("tab", { name: "Console" }).click()

  await typeLine(page, "echo $MARK")
  await expect(terminal(page)).toContainText("still-here")

  await page.getByRole("button", { name: "Disconnect" }).click()
  await expect(terminal(page)).toContainText("[disconnected]")
})

test("console sessions can't be guessed or used without a session", async ({ page, playwright, baseURL }) => {
  await signIn(page)
  // Signed in, but the session id doesn't exist (or belongs to someone else).
  const missing = await page.request.get("/api/exec/not-a-real-session")
  expect(missing.status()).toBe(404)
  const write = await page.request.post("/api/exec/not-a-real-session", { data: { data: "id\n" } })
  expect(write.status()).toBe(404)

  // No cookie at all: stopped by proxy.ts.
  const anon = await playwright.request.newContext({ baseURL })
  expect((await anon.get("/api/exec/anything")).status()).toBe(401)
  expect((await anon.post("/api/exec/anything", { data: { data: "id\n" } })).status()).toBe(401)
  await anon.dispose()
})
