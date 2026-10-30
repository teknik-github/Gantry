import { execFileSync } from "node:child_process"
import http from "node:http"

import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable, removeContainer } from "./docker"

// Runs after the "login" project, which creates the ADMIN account.
// The built-in Caddy proxy on high ports in front of an nginx container,
// then the external mode.
test.describe.configure({ mode: "serial" })

const WEB = "gantry-test-j-web"
const EXT_NET = "gantry-test-j-ext"
const HTTP_PORT = 19000 + Math.floor(Math.random() * 400)
const HTTPS_PORT = HTTP_PORT + 500
const PLAIN = "e2e-plain.gantry.test"
const SECURE = "e2e-tls.gantry.test"
const TIMEOUT = 300_000

async function cleanup() {
  await removeContainer("gantry-proxy")
  await removeContainer(WEB)
  for (const n of [EXT_NET, "gantry-proxy"]) await docker("DELETE", `/networks/${n}`).catch(() => {})
  for (const v of ["gantry-proxy-data", "gantry-proxy-config"]) await docker("DELETE", `/volumes/${v}`).catch(() => {})
}

test.beforeAll(async () => {
  test.setTimeout(TIMEOUT)
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  await cleanup()
  try {
    await docker("GET", "/images/nginx:stable-alpine/json")
  } catch {
    await docker("POST", "/images/create?fromImage=nginx&tag=stable-alpine")
  }
  const { Id } = await docker<{ Id: string }>("POST", `/containers/create?name=${WEB}`, {
    Image: "nginx:stable-alpine",
    Labels: { "gantry.e2e": "true" },
  })
  await docker("POST", `/containers/${Id}/start`)
  await docker("POST", "/networks/create", { Name: EXT_NET, Labels: { "gantry.e2e": "true" } })
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

/** GET http://127.0.0.1:HTTP_PORT/ with a Host header; resolves status + body. */
function viaProxy(host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: HTTP_PORT, path: "/", headers: { Host: host }, timeout: 5_000 }, (res) => {
      let body = ""
      res.on("data", (c) => (body += c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on("error", () => resolve({ status: 0, body: "" }))
    req.on("timeout", () => req.destroy())
  })
}

/** HTTPS through the proxy with the right SNI (self-signed: -k). */
function viaProxyTls(host: string) {
  try {
    return execFileSync(
      "curl",
      ["-sk", "--max-time", "5", "--resolve", `${host}:${HTTPS_PORT}:127.0.0.1`, `https://${host}:${HTTPS_PORT}/`],
      { encoding: "utf8" }
    )
  } catch {
    return ""
  }
}

async function addHost(page: Page, domains: string, tls: string) {
  await page.getByRole("button", { name: "Add host" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("textbox", { name: "Domains" }).fill(domains)
  await dialog.getByRole("combobox", { name: "Container" }).click()
  await page.getByRole("option", { name: WEB }).click()
  await dialog.getByRole("spinbutton", { name: "Port" }).fill("80")
  await dialog.getByRole("combobox", { name: "TLS" }).click()
  await page.getByRole("option", { name: tls }).click()
  await dialog.getByRole("button", { name: "Save" }).click()
  return dialog
}

test("the built-in proxy serves containers by domain over HTTP and HTTPS", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page)
  await page.goto("/proxy")

  await page.getByRole("combobox", { name: "Mode" }).click()
  await page.getByRole("option", { name: "Built-in (Caddy)" }).click()
  await page.getByRole("spinbutton", { name: "HTTP port on the host" }).fill(String(HTTP_PORT))
  await page.getByRole("spinbutton", { name: "HTTPS port on the host" }).fill(String(HTTPS_PORT))
  await page.getByRole("button", { name: "Save & apply" }).click()
  await expect(page.getByText("Built-in proxy configured")).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId("proxy-status")).toHaveText(`running on :${HTTP_PORT} / :${HTTPS_PORT}`)

  // Validation: bad and duplicate domains.
  let dialog = await addHost(page, "not a domain", "HTTP only")
  await expect(dialog.getByText(/Not a valid domain: not, a, domain/)).toBeVisible()
  await dialog.getByRole("textbox", { name: "Domains" }).fill(PLAIN)
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
  await expect(page.getByText(`${PLAIN} saved`)).toBeVisible()

  await expect.poll(async () => (await viaProxy(PLAIN)).body, { timeout: 30_000 }).toContain("Welcome to nginx")
  // The target was attached to the proxy network.
  const web = await docker<{ NetworkSettings: { Networks: Record<string, unknown> } }>("GET", `/containers/${WEB}/json`)
  expect(Object.keys(web.NetworkSettings.Networks)).toContain("gantry-proxy")

  dialog = await addHost(page, PLAIN, "Self-signed")
  await expect(dialog.getByText(`Already used by another host: ${PLAIN}`)).toBeVisible()
  await dialog.getByRole("textbox", { name: "Domains" }).fill(SECURE)
  await dialog.getByRole("button", { name: "Save" }).click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
  await expect.poll(() => viaProxyTls(SECURE), { timeout: 60_000 }).toContain("Welcome to nginx")

  // Disabled hosts are no longer served.
  const row = page.getByRole("row").filter({ hasText: PLAIN })
  await row.getByRole("switch", { name: `${PLAIN} enabled` }).click()
  await expect(page.getByText(`${PLAIN} disabled`)).toBeVisible({ timeout: 60_000 })
  await expect.poll(async () => (await viaProxy(PLAIN)).body, { timeout: 30_000 }).not.toContain("Welcome to nginx")
  await expect(page.getByTestId("proxy-error")).toHaveCount(0)
})

test("external mode removes the built-in proxy, attaches targets and shows config", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page)
  await page.goto("/proxy")
  await page.getByRole("combobox", { name: "Mode" }).click()
  await page.getByRole("option", { name: "External proxy" }).click()
  await page.getByRole("textbox", { name: "Proxy network" }).fill(EXT_NET)
  await page.getByRole("button", { name: "Save & apply" }).click()
  await expect(page.getByText("External proxy configured")).toBeVisible({ timeout: 120_000 })
  // The form keeps the saved choice (no reset to the first value).
  await expect(page.getByRole("combobox", { name: "Mode" })).toHaveText("External proxy")

  await expect.poll(async () => (await docker("GET", "/containers/gantry-proxy/json").then(() => true, () => false))).toBe(false)
  const web = await docker<{ NetworkSettings: { Networks: Record<string, unknown> } }>("GET", `/containers/${WEB}/json`)
  expect(Object.keys(web.NetworkSettings.Networks)).toContain(EXT_NET)

  await page.getByRole("row").filter({ hasText: SECURE }).getByRole("button", { name: `Config for ${SECURE}` }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText(`traefik.docker.network=${EXT_NET}`)
  await expect(dialog).toContainText(`Host(\`${SECURE}\`)`)
  await expect(dialog).toContainText(`proxy_pass http://${WEB}:80;`)
  await page.keyboard.press("Escape")

  // A network that doesn't exist is reported, not created.
  await page.getByRole("textbox", { name: "Proxy network" }).fill("gantry-test-j-missing")
  await page.getByRole("button", { name: "Save & apply" }).click()
  await expect(page.getByText(/doesn't exist on this environment/).first()).toBeVisible({ timeout: 60_000 })

  await page.getByRole("combobox", { name: "Mode" }).click()
  await page.getByRole("option", { name: "Off" }).click()
  await page.getByRole("button", { name: "Save & apply" }).click()
  await expect(page.getByText("Proxy turned off")).toBeVisible({ timeout: 60_000 })
})
