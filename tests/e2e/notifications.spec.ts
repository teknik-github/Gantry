import http from "node:http"
import type { AddressInfo } from "node:net"

import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable, removeContainer } from "./docker"

// Runs after the "login" project, which creates the ADMIN account.
// A local webhook receiver stands in for Telegram/Discord/…: Gantry posts
// alerts to it, including a real crash picked up from Docker events.
test.describe.configure({ mode: "serial" })

const CRASH = "gantry-test-i-crash"
const QUIET = "gantry-test-i-quiet"
const CHANNEL = "E2E hook"

type Received = { kind: string; subject: string; message: string; environment: string }
const received: Received[] = []
let server: http.Server
let hookUrl = ""

test.beforeAll(async () => {
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      try {
        received.push(JSON.parse(body) as Received)
      } catch {
        // ignore
      }
      res.writeHead(204).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`
  for (const name of [CRASH, QUIET]) await removeContainer(name)
})

test.afterAll(async () => {
  for (const name of [CRASH, QUIET]) await removeContainer(name)
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
})

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

/** A container that exits with code 3 by itself after a moment. */
async function crashingContainer(name: string) {
  const { Id } = await docker<{ Id: string }>("POST", `/containers/create?name=${name}`, {
    Image: "alpine:3",
    Cmd: ["sh", "-c", "sleep 2; exit 3"],
    Labels: { "gantry.e2e": "true" },
  })
  await docker("POST", `/containers/${Id}/start`)
}

const timeout = 60_000

test("a webhook channel receives a test message and real crash alerts", async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page)
  await page.goto("/notifications")

  await page.getByRole("button", { name: "Add channel" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(CHANNEL)
  await dialog.getByRole("combobox", { name: "Type" }).click()
  await page.getByRole("option", { name: "Webhook (JSON)" }).click()
  // Validation: a non-http URL is refused.
  await dialog.getByLabel("URL").fill("ftp://example.com")
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog.getByText("Use an http(s) URL")).toBeVisible()
  await dialog.getByLabel("URL").fill(hookUrl)
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden()

  const row = page.getByRole("row").filter({ hasText: CHANNEL })
  await expect(row).toContainText("127.0.0.1")
  await expect(row).toContainText("All alerts")
  // The URL is a secret: never rendered back.
  await expect(page.locator("body")).not.toContainText(hookUrl)

  await row.getByRole("button", { name: `Send a test to ${CHANNEL}` }).click()
  await expect(page.getByText(`Test sent to ${CHANNEL}`)).toBeVisible()
  await expect.poll(() => received.some((r) => r.kind === "test")).toBe(true)

  // A container that dies on its own is reported (Docker events → alert → webhook).
  await crashingContainer(CRASH)
  await expect
    .poll(() => received.find((r) => r.kind === "container_crash" && r.subject.includes(CRASH))?.subject, { timeout })
    .toBe(`${CRASH} crashed (exit code 3)`)

  await page.reload()
  const alert = page.getByRole("row").filter({ hasText: `${CRASH} crashed (exit code 3)` })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText("1 sent")
})

test("channels can be edited without retyping the URL, paused and removed", async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page)
  await page.goto("/notifications")
  const row = page.getByRole("row").filter({ hasText: CHANNEL })

  await row.getByRole("button", { name: `Edit ${CHANNEL}` }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("URL")).toHaveValue("")
  // Only crash alerts from now on.
  for (const label of ["Out of memory", "Unhealthy", "Restart loop", "Environment unreachable", "Image update available", "Auto-update result"]) {
    await dialog.getByRole("checkbox", { name: new RegExp(`^${label}`) }).click()
  }
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden()
  await expect(row).toContainText("Container crashed")
  const before = received.length
  await row.getByRole("button", { name: `Send a test to ${CHANNEL}` }).click()
  await expect(page.getByText(`Test sent to ${CHANNEL}`)).toBeVisible()
  await expect.poll(() => received.length).toBe(before + 1)

  // Paused: alerts are still recorded but not delivered.
  await row.getByRole("switch", { name: `${CHANNEL} enabled` }).click()
  await expect(row.getByRole("switch", { name: `${CHANNEL} enabled` })).not.toBeChecked()
  const sent = received.length
  await crashingContainer(QUIET)
  await expect
    .poll(
      async () => {
        await page.reload()
        // allTextContents doesn't wait for the row to exist (textContent would).
        return (await page.getByRole("row").filter({ hasText: `${QUIET} crashed` }).allTextContents()).join(" ")
      },
      { timeout }
    )
    .toContain("no channel")
  expect(received.length).toBe(sent)

  await row.getByRole("button", { name: `Remove ${CHANNEL}` }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await expect(page.getByRole("row").filter({ hasText: CHANNEL })).toHaveCount(0)
})
