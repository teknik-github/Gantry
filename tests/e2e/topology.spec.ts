import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable, removeContainer } from "./docker"

// Runs after the "login" project, which creates the ADMIN account.
// Builds a small fake compose project (web depends on db) on a scratch
// network + volume and checks how /topology draws it.
test.describe.configure({ mode: "serial" })

const PROJECT = "gantry-test-e-proj"
const NET = "gantry-test-e-topo-net"
const VOL = "gantry-test-e-topo-vol"
const DB = "gantry-test-e-topo-db"
const WEB = "gantry-test-e-topo-web"
const CACHE = "gantry-test-e-topo-cache"
const E2E_LABEL = { "gantry.e2e": "true" }

const ids = { db: "", web: "" }

async function cleanup() {
  for (const name of [CACHE, WEB, DB]) await removeContainer(name)
  await docker("DELETE", `/volumes/${VOL}`).catch(() => {})
  await docker("DELETE", `/networks/${NET}`).catch(() => {})
}

async function composeContainer(name: string, service: string, dependsOn: string, extra: Record<string, unknown> = {}) {
  const { Id } = await docker<{ Id: string }>("POST", `/containers/create?name=${name}`, {
    Image: "alpine:3",
    Cmd: ["sleep", "900"],
    Labels: {
      ...E2E_LABEL,
      "com.docker.compose.project": PROJECT,
      "com.docker.compose.service": service,
      "com.docker.compose.depends_on": dependsOn,
      "com.docker.compose.oneoff": "False",
    },
    HostConfig: {
      NetworkMode: NET,
      Mounts: [{ Type: "volume", Source: VOL, Target: "/data", ReadOnly: service === "web" }],
    },
    NetworkingConfig: { EndpointsConfig: { [NET]: { Aliases: [service === "db" ? "database" : service] } } },
    ...extra,
  })
  await docker("POST", `/containers/${Id}/start`)
  return Id
}

// Docker on a busy shared host can take a while to create containers.
const DOCKER_TIMEOUT = 240_000

test.beforeAll(async () => {
  test.setTimeout(DOCKER_TIMEOUT)
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  await cleanup()
  await docker("POST", "/networks/create", { Name: NET, Driver: "bridge", Labels: E2E_LABEL })
  await docker("POST", "/volumes/create", { Name: VOL, Labels: E2E_LABEL })
  ids.db = await composeContainer(DB, "db", "")
  ids.web = await composeContainer(WEB, "web", "db:service_started:false")
})

test.afterAll(async () => {
  test.setTimeout(DOCKER_TIMEOUT)
  await cleanup()
})

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

test("topology shows a compose project with its network, volume and dependencies", async ({ page }) => {
  await signIn(page)
  await page.goto(`/topology?project=${PROJECT}`)

  const canvas = page.getByTestId("topology-canvas")
  await expect(page.getByRole("combobox", { name: "Compose project" })).toContainText(PROJECT)
  await expect(canvas.getByLabel(`Compose project ${PROJECT}`)).toBeVisible()
  await expect(canvas.getByLabel(`Compose project ${PROJECT}`)).toContainText("2/2 running")

  // Only this project's containers, titled by service.
  await expect(canvas.getByTestId("topology-container")).toHaveCount(2)
  await expect(canvas.getByLabel(`Container ${WEB}`)).toContainText("web")
  await expect(canvas.getByLabel(`Container ${DB}`)).toContainText("db")
  await expect(canvas.getByLabel(`Network ${NET}`)).toBeVisible()
  await expect(canvas.getByLabel(`Volume ${VOL}`)).toBeVisible()
  await expect(canvas.getByTestId("topology-network")).toHaveCount(1)
  await expect(canvas.getByTestId("topology-volume")).toHaveCount(1)

  // web → db dependency edge, plus network and volume edges.
  const dep = `dep:container:${ids.web}->container:${ids.db}`
  await expect(canvas.locator(`.react-flow__edge[data-id="${dep}"]`)).toHaveCount(1)
  await expect(canvas.locator(".react-flow__edge")).toHaveCount(5)

  // Selecting a container focuses its edges (labels shown) and opens the details panel.
  await canvas.getByLabel(`Container ${WEB}`).click()
  await expect(canvas.getByTestId("topology-edge-label-depends")).toHaveText("started")
  await expect(canvas.getByTestId("topology-edge-label-volume")).toContainText("/data (ro)")
  await expect(canvas.getByTestId("topology-edge-label-network")).toContainText("web")

  const panel = page.getByTestId("topology-details")
  await expect(panel).toBeVisible()
  await expect(panel).toContainText(WEB)
  await expect(panel).toContainText(`${PROJECT} / web`)
  await expect(panel.getByRole("link", { name: DB })).toHaveAttribute("href", `/containers/${ids.db}`)
  await expect(panel.getByRole("link", { name: NET })).toHaveAttribute("href", "/networks")
  await expect(panel.getByRole("link", { name: VOL })).toHaveAttribute("href", "/volumes")

  // Escape closes the panel; other nodes have their own details.
  await page.keyboard.press("Escape")
  await expect(panel).toBeHidden()
  await canvas.getByLabel(`Volume ${VOL}`).click()
  await expect(panel).toContainText("Mounted by (2)")
  await page.keyboard.press("Escape")
  await expect(panel).toBeHidden()

  await canvas.getByLabel(`Container ${WEB}`).click()
  const open = panel.getByRole("link", { name: "Open container" })
  await expect(open).toHaveAttribute("href", `/containers/${ids.web}`)
  await open.click()
  await expect(page).toHaveURL(new RegExp(`/containers/${ids.web}$`))
})

test("topology follows Docker without reloading", async ({ page }) => {
  test.setTimeout(DOCKER_TIMEOUT)
  await signIn(page)
  await page.goto(`/topology?project=${PROJECT}`)
  await expect(page.getByTestId("live-indicator")).toHaveAttribute("data-status", "connected")
  const canvas = page.getByTestId("topology-canvas")
  await expect(canvas.getByTestId("topology-container")).toHaveCount(2)
  // A reload would drop this marker.
  await page.evaluate(() => ((window as unknown as { __gantryNoReload: boolean }).__gantryNoReload = true))

  // Generous: the Docker host is shared and busy.
  const timeout = 45_000
  const id = await composeContainer(CACHE, "cache", "db:service_healthy:true")
  await expect(canvas.getByLabel(`Container ${CACHE}`)).toBeVisible({ timeout })
  await expect(canvas.getByTestId("topology-container")).toHaveCount(3)
  await expect(canvas.getByLabel(`Compose project ${PROJECT}`)).toContainText("3/3 running")
  await expect(canvas.locator(`.react-flow__edge[data-id="dep:container:${id}->container:${ids.db}"]`)).toHaveCount(1)

  await removeContainer(id)
  await expect(canvas.getByLabel(`Container ${CACHE}`)).toHaveCount(0, { timeout })
  await expect(canvas.getByTestId("topology-container")).toHaveCount(2)
  expect(await page.evaluate(() => (window as unknown as { __gantryNoReload?: boolean }).__gantryNoReload)).toBe(true)
})

test("topology filters: search, stopped containers and the project select", async ({ page }) => {
  test.setTimeout(DOCKER_TIMEOUT)
  await signIn(page)
  await page.goto(`/topology?project=${PROJECT}`)
  const canvas = page.getByTestId("topology-canvas")
  await expect(canvas.getByTestId("topology-container")).toHaveCount(2)

  await page.getByLabel("Search topology").fill("topo-db")
  await expect(page.getByText("1 match", { exact: true })).toBeVisible()
  await expect(canvas.getByLabel(`Container ${DB}`)).toHaveClass(/ring-amber-400/)
  await expect(canvas.getByLabel(`Container ${WEB}`)).toHaveClass(/opacity-25/)
  await page.getByLabel("Search topology").fill("")

  await docker("POST", `/containers/${ids.web}/stop?t=0`)
  await page.reload()
  await expect(canvas.getByLabel(`Compose project ${PROJECT}`)).toContainText("1/2 running")
  await page.getByLabel("Hide stopped").click()
  await expect(canvas.getByTestId("topology-container")).toHaveCount(1)
  await expect(page.getByTestId("topology-summary")).toContainText("1 stopped hidden")
  // The read-only mount from web is gone, the volume stays for db.
  await expect(canvas.getByLabel(`Volume ${VOL}`)).toBeVisible()

  // Switching to all projects updates the URL.
  await page.getByRole("combobox", { name: "Compose project" }).click()
  await page.getByRole("option", { name: "All projects" }).click()
  await expect(page).toHaveURL(/\/topology$/)
  await expect(canvas.getByLabel(`Compose project ${PROJECT}`)).toBeVisible()
})

test("unknown project falls back to everything", async ({ page }) => {
  await signIn(page)
  await page.goto("/topology?project=gantry-test-e-does-not-exist")
  await expect(page.getByTestId("topology-summary")).toContainText("has no containers here")
  await expect(page.getByRole("combobox", { name: "Compose project" })).toContainText("All projects")
})
