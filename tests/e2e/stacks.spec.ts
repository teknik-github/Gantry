import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable } from "./docker"

// Runs after the "login" project, which creates the ADMIN account.
test.describe.configure({ mode: "serial" })

const STACK = `gantry-test-a-e2e-${Date.now().toString(36)}`

// ${SLEEP} comes from the stack's .env, so this also checks env interpolation.
const COMPOSE = `services:
  app:
    image: alpine:3
    command: ["sleep", "\${SLEEP}"]
    # tini forwards SIGTERM, so stop/down don't wait out the grace period.
    init: true
    stop_grace_period: 2s
    labels:
      gantry.e2e: "true"
networks:
  default:
    labels:
      gantry.e2e: "true"
`

test.beforeAll(async () => {
  test.skip(!(await dockerAvailable()), "Docker socket not available")
})

// Whatever the tests left behind: only resources of this test's own project.
test.afterAll(async () => {
  test.setTimeout(120_000)
  if (!(await dockerAvailable())) return
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${STACK}`] }))
  const containers = await docker<{ Id: string }[]>("GET", `/containers/json?all=true&filters=${filters}`).catch(() => [])
  for (const c of containers) await docker("DELETE", `/containers/${c.Id}?force=true&v=true`).catch(() => {})
  const networks = await docker<{ Id: string }[]>("GET", `/networks?filters=${filters}`).catch(() => [])
  for (const n of networks) await docker("DELETE", `/networks/${n.Id}`).catch(() => {})
})

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

const header = (page: Page) => page.getByRole("main").getByRole("heading", { level: 2, name: STACK })

test("admin can create, deploy, stop, take down and delete a stack", async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)

  await page.goto("/stacks")
  await page.getByRole("link", { name: "Add stack" }).click()
  await expect(page).toHaveURL(/\/stacks\/new$/)

  // Validation errors are shown inline and the input is kept.
  await page.getByLabel("Name").fill(STACK)
  await page.getByLabel("Compose file").fill("services:\n  app: [oops\n")
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await expect(page.getByText(/Invalid YAML/)).toBeVisible()
  await expect(page.getByLabel("Name")).toHaveValue(STACK)

  await page.getByLabel("Compose file").fill(COMPOSE)
  await page.getByLabel("Environment variables").fill("SLEEP=600\n")
  await page.getByRole("button", { name: "Create & deploy" }).click()

  await expect(page).toHaveURL(/\/stacks\/\d+$/, { timeout: 120_000 })
  await expect(header(page)).toContainText("running")
  await expect(header(page)).toContainText("1/1")
  await expect(page.getByTestId("stack-output")).toContainText("up -d --remove-orphans")
  const containerLink = page.getByRole("link", { name: `${STACK}-app-1` })
  await expect(containerLink).toHaveAttribute("href", /^\/containers\/[a-f0-9]{64}$/)

  // The container really runs with the value from .env.
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${STACK}`] }))
  const [container] = await docker<{ Id: string; Command: string; State: string }[]>(
    "GET",
    `/containers/json?all=true&filters=${filters}`
  )
  expect(container.State).toBe("running")
  expect(container.Command).toBe("sleep 600")

  // Listed on /stacks with its running count.
  await page.goto("/stacks")
  const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: STACK }) })
  await expect(row).toContainText("running")
  await expect(row).toContainText("1/1")
  await row.getByRole("link", { name: STACK }).click()

  await page.getByRole("button", { name: "Stop", exact: true }).click()
  await expect(header(page)).toContainText("stopped", { timeout: 120_000 })
  await expect(page.getByTestId("stack-output")).toContainText("docker compose stop")

  await page.getByRole("button", { name: "Down", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Down", exact: true }).click()
  await expect(header(page)).toContainText("not deployed", { timeout: 120_000 })
  expect(await docker<unknown[]>("GET", `/containers/json?all=true&filters=${filters}`)).toHaveLength(0)

  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page).toHaveURL(/\/stacks$/, { timeout: 120_000 })
  await expect(page.getByRole("link", { name: STACK })).toHaveCount(0)
})
