import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable } from "./docker"

// Runs after the "login" project, which creates the ADMIN account.
// Built-in and custom templates, deployed as stacks.
test.describe.configure({ mode: "serial" })

const SUFFIX = Date.now().toString(36)
const NGINX_STACK = `gantry-test-g-nginx-${SUFFIX}`
const CUSTOM_STACK = `gantry-test-g-custom-${SUFFIX}`
const CUSTOM_TITLE = `E2E template ${SUFFIX}`
const NGINX_PORT = String(18000 + Math.floor(Math.random() * 1000))

const CUSTOM_COMPOSE = `services:
  app:
    image: alpine:3
    command: ["sh", "-c", "echo $$GREETING && sleep 600"]
    init: true
    environment:
      GREETING: \${GREETING:-hello}
      APP_PASSWORD: \${APP_PASSWORD}
    labels:
      gantry.e2e: "true"
networks:
  default:
    labels:
      gantry.e2e: "true"
`

const TIMEOUT = 300_000
const timeout = 120_000

async function removeProject(project: string) {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${project}`] }))
  const containers = await docker<{ Id: string }[]>("GET", `/containers/json?all=true&filters=${filters}`).catch(() => [])
  for (const c of containers) await docker("DELETE", `/containers/${c.Id}?force=true&v=true`).catch(() => {})
  const networks = await docker<{ Id: string }[]>("GET", `/networks?filters=${filters}`).catch(() => [])
  for (const n of networks) await docker("DELETE", `/networks/${n.Id}`).catch(() => {})
  const volumes = await docker<{ Volumes: { Name: string }[] | null }>("GET", `/volumes?filters=${filters}`).catch(() => ({ Volumes: [] }))
  for (const v of volumes.Volumes ?? []) await docker("DELETE", `/volumes/${v.Name}`).catch(() => {})
}

test.beforeAll(async () => {
  test.skip(!(await dockerAvailable()), "Docker socket not available")
})

test.afterAll(async () => {
  test.setTimeout(TIMEOUT)
  for (const p of [NGINX_STACK, CUSTOM_STACK]) await removeProject(p)
})

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

// Next keeps recently visited pages in the DOM (hidden) for back/forward;
// role locators skip hidden elements, getByLabel doesn't.
const stackName = (page: Page) => page.getByRole("textbox", { name: "Stack name", exact: true })

async function deleteStackFromItsPage(page: Page) {
  await page.getByRole("button", { name: "Delete" }).click()
  const dialog = page.getByRole("alertdialog")
  await dialog.getByLabel(/Also remove the stack/).click()
  await dialog.getByRole("button", { name: "Delete" }).click()
  await expect(page).toHaveURL(/\/stacks$/, { timeout })
}

test("the gallery lists built-in templates with search and categories", async ({ page }) => {
  await signIn(page)
  await page.goto("/stacks")
  await page.getByRole("link", { name: "From template" }).click()
  await expect(page).toHaveURL(/\/templates$/)

  await expect(page.getByRole("link", { name: "Template PostgreSQL" })).toBeVisible()
  await page.getByRole("radio", { name: "Monitoring" }).click()
  await expect(page.getByRole("link", { name: "Template Uptime Kuma" })).toBeVisible()
  await expect(page.getByRole("link", { name: "Template PostgreSQL" })).toHaveCount(0)
  await page.getByRole("radio", { name: "All" }).click()
  await page.getByLabel("Search templates").fill("wordpress")
  await expect(page.getByRole("link", { name: /^Template / })).toHaveCount(1)
  await page.getByRole("link", { name: "Template WordPress" }).click()
  await expect(page.getByTestId("template-compose")).toContainText("mariadb:11")
  await expect(page.getByLabel("Database password")).toHaveAttribute("type", "password")
})

test("a built-in template deploys as a stack with generated passwords", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page)
  await page.goto("/templates/nginx")
  await expect(stackName(page)).toHaveValue("nginx")

  // The browser refuses an out-of-range port; the server checks the rest and keeps the values.
  await page.getByLabel("HTTP port").fill("99999")
  expect(await page.getByLabel("HTTP port").evaluate((el: HTMLInputElement) => el.checkValidity())).toBe(false)
  await page.getByLabel("HTTP port").fill(NGINX_PORT)
  await stackName(page).fill("Not Valid!")
  await page.getByRole("button", { name: "Deploy" }).click()
  await expect(page.getByText(/must start with a letter or digit/)).toBeVisible()
  await expect(page.getByLabel("HTTP port")).toHaveValue(NGINX_PORT)

  await stackName(page).fill(NGINX_STACK)
  await page.getByRole("button", { name: "Deploy" }).click()
  await expect(page).toHaveURL(/\/stacks\/\d+$/, { timeout })
  await expect(page.getByRole("main").getByRole("heading", { level: 2, name: NGINX_STACK })).toContainText("1/1", { timeout })
  await expect(page.getByLabel("Environment variables")).toHaveValue(new RegExp(`HTTP_PORT=${NGINX_PORT}`))

  // nginx answers on the chosen port.
  await expect
    .poll(async () => (await fetch(`http://127.0.0.1:${NGINX_PORT}/`).catch(() => null))?.status ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(0)
  await deleteStackFromItsPage(page)
})

test("custom templates: create from your own compose file, deploy, save a stack back as a template", async ({ page }) => {
  test.setTimeout(TIMEOUT)
  await signIn(page)
  await page.goto("/templates")
  await page.getByRole("link", { name: "New template" }).click()

  await page.getByLabel("Title").fill(CUSTOM_TITLE)
  await page.getByLabel("Description").fill("Greets and sleeps")
  await page.getByLabel("Default stack name").fill("greeter")
  await page.getByLabel("Compose file").fill(CUSTOM_COMPOSE)
  // Variables are detected as you type.
  const vars = page.getByTestId("template-variables")
  await expect(vars).toContainText("GREETING=hello")
  await expect(vars).toContainText("APP_PASSWORD")
  await page.getByRole("button", { name: "Save template" }).click()

  await expect(page).toHaveURL(/\/templates\/c-\d+$/, { timeout })
  const templateUrl = page.url()
  await expect(page.getByRole("heading", { level: 2 })).toContainText(CUSTOM_TITLE)
  await expect(page.getByRole("textbox", { name: "GREETING", exact: true })).toHaveValue("hello")
  await expect(page.locator("input[name='var:APP_PASSWORD']:visible")).toHaveAttribute("type", "password")

  await stackName(page).fill(CUSTOM_STACK)
  await page.getByRole("textbox", { name: "GREETING", exact: true }).fill("hi from e2e")
  await page.getByRole("button", { name: "Deploy" }).click()
  await expect(page).toHaveURL(/\/stacks\/\d+$/, { timeout })
  await expect(page.getByRole("main").getByRole("heading", { level: 2, name: CUSTOM_STACK })).toContainText("1/1", { timeout })

  // The container got the typed value and a generated password.
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${CUSTOM_STACK}`] }))
  const [c] = await docker<{ Id: string }[]>("GET", `/containers/json?filters=${filters}`)
  const info = await docker<{ Config: { Env: string[] } }>("GET", `/containers/${c.Id}/json`)
  expect(info.Config.Env).toContain("GREETING=hi from e2e")
  const pw = info.Config.Env.find((e) => e.startsWith("APP_PASSWORD="))?.split("=")[1] ?? ""
  expect(pw).toMatch(/^[A-Za-z0-9]{24}$/)

  // Save the stack as a template: the password is left out.
  await page.getByRole("button", { name: "Save as template" }).click()
  await expect(page).toHaveURL(/\/templates\/c-\d+$/, { timeout })
  await expect(page.getByRole("heading", { level: 2 })).toContainText(CUSTOM_STACK)
  await expect(page.getByRole("textbox", { name: "GREETING", exact: true })).toHaveValue("hi from e2e")
  await expect(page.locator("input[name='var:APP_PASSWORD']:visible")).toHaveValue("")
  // Delete that copy.
  await page.getByRole("button", { name: "Delete" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page).toHaveURL(/\/templates$/, { timeout })

  // Edit, then delete the original template; the stack it created stays.
  await page.goto(templateUrl)
  await page.getByRole("link", { name: "Edit" }).click()
  await page.getByRole("textbox", { name: "Description", exact: true }).fill("Edited description")
  await page.getByRole("button", { name: "Save template" }).click()
  await expect(page).toHaveURL(templateUrl, { timeout })
  await expect(page.getByText("Edited description")).toBeVisible()
  await page.getByRole("button", { name: "Delete" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click()
  await expect(page).toHaveURL(/\/templates$/, { timeout })
  await expect(page.getByRole("link", { name: `Template ${CUSTOM_TITLE}` })).toHaveCount(0)

  await page.goto("/stacks")
  await page.getByRole("link", { name: CUSTOM_STACK }).click()
  await deleteStackFromItsPage(page)
})
