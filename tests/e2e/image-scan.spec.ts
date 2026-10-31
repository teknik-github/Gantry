import http from "node:http"
import type { AddressInfo } from "node:net"

import { expect, test, type Browser, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable, removeContainer } from "./docker"

// Vulnerability scanning end to end with the real Trivy: an old Alpine with
// known CVEs is scanned from the Images table (row and bulk), the findings
// page filters them, the container page links to them, a viewer can only
// look, and a webhook receives one "vulnerability" alert, not one per scan.
// Runs after the "login" project, which creates the ADMIN account.
// The server runs with TRIVY_CACHE_VOLUME=gantry-test-s-trivy-cache
// (playwright.config.ts); the volume is removed afterwards unless
// E2E_KEEP_TRIVY_CACHE=1 (saves the database download on the next run).
test.describe.configure({ mode: "serial" })

const IMAGE = { repo: "alpine", tag: "3.10" }
const REF = `${IMAGE.repo}:${IMAGE.tag}`
// A known vulnerability of alpine:3.10 (apk-tools, critical, fixed in 2.10.7-r0).
const KNOWN_CVE = "CVE-2021-36159"
/** DEFAULT_TRIVY_IMAGE in lib/server/trivy.ts. */
const SCANNER = "aquasec/trivy:0.76.1"
const CACHE_VOLUME = "gantry-test-s-trivy-cache"
const CONTAINER = "gantry-test-s-vuln"
const VIEWER = { username: "gantry-test-s-viewer", password: "e2e-Scan-Passw0rd" }
const CHANNEL = "E2E scan hook"
/** The first scan may pull the scanner and download Trivy's database. */
const SCAN_TIMEOUT = 900_000
/** /images/json is slow with the containerd image store. */
const timeout = 90_000

type Received = { kind: string; subject: string; message: string; environment: string }
const received: Received[] = []
let server: http.Server
let hookUrl = ""
let pulledImage = false
let pulledScanner = false
let imageId = ""
let containerId = ""

const exists = (ref: string) =>
  docker("GET", `/images/${encodeURIComponent(ref)}/json`).then(
    () => true,
    () => false
  )

test.beforeAll(async () => {
  test.setTimeout(600_000)
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

  pulledScanner = !(await exists(SCANNER))
  if (!(await exists(REF))) {
    await docker("POST", `/images/create?fromImage=${IMAGE.repo}&tag=${IMAGE.tag}`)
    pulledImage = true
  }
  imageId = (await docker<{ Id: string }>("GET", `/images/${encodeURIComponent(REF)}/json`)).Id
  await removeContainer(CONTAINER)
  containerId = (
    await docker<{ Id: string }>("POST", `/containers/create?name=${CONTAINER}`, {
      Image: REF,
      Cmd: ["sleep", "1800"],
      Labels: { "gantry.e2e": "true" },
    })
  ).Id
})

test.afterAll(async () => {
  test.setTimeout(300_000)
  await removeContainer(CONTAINER)
  // Images and the volume this run brought in, by name.
  if (pulledImage) await docker("DELETE", `/images/${encodeURIComponent(REF)}`).catch(() => {})
  if (pulledScanner) await docker("DELETE", `/images/${encodeURIComponent(SCANNER)}`).catch(() => {})
  if (!process.env.E2E_KEEP_TRIVY_CACHE) await docker("DELETE", `/volumes/${CACHE_VOLUME}`).catch(() => {})
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
})

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

/** The Images table filtered down to the test image's row. */
async function imageRow(page: Page) {
  await page.goto("/images")
  await page.getByLabel("Search").fill(REF)
  const row = page.getByRole("row").filter({ hasText: REF })
  await expect(row).toHaveCount(1, { timeout })
  return row
}

type Summary = { imageId: string; scannedAt: string | null; pending: string | null; counts: Record<string, number> }

async function scanState(page: Page): Promise<Summary | undefined> {
  const res = await page.request.get("/api/image-scans")
  expect(res.status()).toBe(200)
  return ((await res.json()) as { scans: Summary[] }).scans.find((s) => s.imageId === imageId)
}

const vulnerabilityAlerts = () => received.filter((r) => r.kind === "vulnerability")

test("admin adds a webhook channel and sets the alert severity", async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, ADMIN)
  await page.goto("/notifications")
  await page.getByRole("button", { name: "Add channel" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill(CHANNEL)
  await dialog.getByRole("combobox", { name: "Type" }).click()
  await page.getByRole("option", { name: "Webhook (JSON)" }).click()
  await dialog.getByLabel("URL").fill(hookUrl)
  // The new alert kind is offered (and on by default).
  await expect(dialog.getByRole("checkbox", { name: /^Vulnerabilities found/ })).toBeChecked()
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden()

  await page.goto("/images")
  const card = page.locator("[data-slot=card]").filter({ hasText: "Vulnerability scanning" })
  await expect(card).toBeVisible({ timeout })
  await expect(card).toContainText(SCANNER)
  await card.getByRole("combobox", { name: "Alert from" }).click()
  await page.getByRole("option", { name: "High and up" }).click()
  await card.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText(/alerts from high up/)).toBeVisible()

  await page.reload()
  await expect(page.locator("[data-slot=card]").filter({ hasText: "Vulnerability scanning" }).getByRole("combobox", { name: "Alert from" })).toHaveText(
    "High and up",
    { timeout }
  )
})

test("scanning an image shows severity badges and raises one alert", async ({ page }) => {
  test.setTimeout(SCAN_TIMEOUT + 120_000)
  await signIn(page, ADMIN)
  const row = await imageRow(page)
  await expect(row).toContainText("Not scanned")

  await row.getByRole("button", { name: `Scan ${REF}` }).click()
  await expect(page.getByText(`Scanning ${REF}`)).toBeVisible()
  // Queued/running while the scanner works, then the counts (no reload needed).
  await expect(row.getByTestId(/^vuln-(scanning|queued)$/)).toBeVisible({ timeout })
  await expect(row.getByTestId("vuln-badges")).toBeVisible({ timeout: SCAN_TIMEOUT })
  expect(Number(await row.getByTestId("vuln-critical").getAttribute("data-count"))).toBeGreaterThan(0)

  const state = await scanState(page)
  expect(state?.counts.CRITICAL).toBeGreaterThan(0)
  await expect.poll(() => vulnerabilityAlerts().length, { timeout: 30_000 }).toBe(1)
  const alert = vulnerabilityAlerts()[0]
  expect(alert.subject).toMatch(new RegExp(`^${REF.replace(".", "\\.")}: \\d+ new vulnerabilit(y|ies) \\(\\d+ critical`))
  expect(alert.message).toContain(KNOWN_CVE)
  expect(alert.environment).toBe("local")

  // The alert is in the history too.
  await page.goto("/notifications")
  await expect(page.getByRole("row").filter({ hasText: `${REF}: ` }).first()).toContainText("1 sent")
})

test("the findings page filters by severity, fixability and text", async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page, ADMIN)
  const row = await imageRow(page)
  await row.getByRole("link", { name: `Vulnerabilities of ${REF}` }).click()
  await expect(page).toHaveURL(new RegExp(`/images/vulnerabilities/${imageId.slice(7)}$`))
  await expect(page.getByRole("heading", { name: `Vulnerabilities of ${REF}` })).toBeVisible()
  const meta = page.getByTestId("scan-meta")
  await expect(meta).toContainText("Trivy 0.76.1")
  await expect(meta).toContainText(/Vulnerability DB\s*updated/)
  await expect(meta).toContainText("alpine 3.10")
  console.log(`scan details: ${(await meta.textContent())?.replace(/\s+/g, " ")}`)

  const finding = page.getByRole("row").filter({ hasText: KNOWN_CVE })
  await expect(finding).toHaveCount(1)
  await expect(finding).toContainText("apk-tools")
  await expect(finding).toContainText("2.10.7-r0")
  await expect(finding.getByRole("link", { name: KNOWN_CVE })).toHaveAttribute("href", /^https:\/\//)

  // Severity filter: hiding Critical hides the finding.
  const critical = page.getByRole("button", { name: /^Critical \(\d+\)$/ })
  await expect(critical).toHaveAttribute("aria-pressed", "true")
  await critical.click()
  await expect(critical).toHaveAttribute("aria-pressed", "false")
  await expect(finding).toHaveCount(0)
  await critical.click()
  await expect(finding).toHaveCount(1)

  // Fixable only: every remaining row has a fixed version.
  await page.getByRole("switch", { name: "Fixable only" }).click()
  await expect(finding).toHaveCount(1)
  await expect(page.getByRole("row").filter({ hasText: "no fix yet" })).toHaveCount(0)
  await page.getByRole("switch", { name: "Fixable only" }).click()

  // Search (the Images page we came from stays in the DOM, hidden: pick this page's box).
  const search = page.getByPlaceholder("Search CVE, package or title…")
  await search.fill("apk-tools")
  await expect(finding).toHaveCount(1)
  await search.fill("no-such-package-xyz")
  await expect(page.getByText("No findings match the filters.")).toBeVisible()
})

test("a bulk rescan finds nothing new and doesn't alert again", async ({ page }) => {
  test.setTimeout(SCAN_TIMEOUT)
  await signIn(page, ADMIN)
  const before = (await scanState(page))?.scannedAt
  expect(before).toBeTruthy()
  const row = await imageRow(page)
  await row.getByRole("checkbox", { name: `Select ${REF}` }).check()
  await page.getByTestId("bulk-bar").getByRole("button", { name: /^Scan/ }).click()
  await expect(page.getByText(`Scanning ${REF}`)).toBeVisible()
  await expect
    .poll(async () => {
      const s = await scanState(page)
      return s && !s.pending && s.scannedAt !== before
    }, { timeout: SCAN_TIMEOUT, intervals: [2_000] })
    .toBe(true)
  await expect(row.getByTestId("vuln-badges")).toBeVisible({ timeout })
  // Alerts are sent before a scan counts as done; give delivery a moment anyway.
  await page.waitForTimeout(2_000)
  expect(vulnerabilityAlerts()).toHaveLength(1)
})

test("a container's page shows its image's scan", async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, ADMIN)
  await page.goto(`/containers/${containerId}`)
  const scan = page.getByTestId("container-image-scan")
  await expect(scan.getByTestId("vuln-badges")).toBeVisible({ timeout })
  await scan.getByRole("link", { name: `Vulnerabilities of ${REF}` }).click()
  await expect(page.getByRole("heading", { name: `Vulnerabilities of ${REF}` })).toBeVisible({ timeout })
})

test("a viewer sees the results but can't scan", async ({ page, browser }) => {
  test.setTimeout(300_000)
  await signIn(page, ADMIN)
  await page.goto("/users")
  await page.getByRole("button", { name: "Add user" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Username").fill(VIEWER.username)
  await dialog.getByLabel("Password").fill(VIEWER.password)
  await dialog.getByRole("button", { name: "Create" }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole("button", { name: `Environment access for ${VIEWER.username}` }).click()
  const access = page.getByRole("dialog")
  await access.getByRole("checkbox", { name: "local" }).check()
  await access.getByRole("combobox", { name: "Role for local" }).click()
  await page.getByRole("option", { name: "Viewer", exact: true }).click()
  await access.getByRole("button", { name: "Save" }).click()
  await expect(access).toBeHidden()

  const { context, page: viewer } = await as(browser, VIEWER)
  const row = await imageRow(viewer)
  await expect(row.getByTestId("vuln-badges")).toBeVisible()
  await expect(row.getByRole("button", { name: `Scan ${REF}` })).toHaveCount(0)
  await expect(viewer.getByRole("checkbox")).toHaveCount(0)
  await expect(viewer.getByText("Vulnerability scanning")).toHaveCount(0)
  expect((await scanState(viewer))?.counts.CRITICAL).toBeGreaterThan(0)

  await row.getByRole("link", { name: `Vulnerabilities of ${REF}` }).click()
  await expect(viewer.getByRole("row").filter({ hasText: KNOWN_CVE })).toHaveCount(1, { timeout })
  await expect(viewer.getByRole("button", { name: "Scan now" })).toHaveCount(0)
  await context.close()
})

// Later suites (notifications, setup checks) expect no channel left behind.
test("the test webhook channel is removed again", async ({ page }) => {
  await signIn(page, ADMIN)
  await page.goto("/notifications")
  const row = page.getByRole("row").filter({ hasText: CHANNEL })
  await row.getByRole("button", { name: `Remove ${CHANNEL}` }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await expect(page.getByRole("row").filter({ hasText: CHANNEL })).toHaveCount(0)
})
