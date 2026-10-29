import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable, removeContainer } from "./docker"

// Runs after the "login" project, which creates the ADMIN account.
test.describe.configure({ mode: "serial" })

type Inspect = {
  Id: string
  Name: string
  State: { Running: boolean }
  Config: { Env: string[]; Labels: Record<string, string> }
  HostConfig: { PortBindings: Record<string, { HostIp: string; HostPort: string }[]> }
}

const NAME = `gantry-test-c-e2e-recreate-${Date.now().toString(36)}`
const PORT = 21000 + Math.floor(Math.random() * 4000)
let originalId = ""

async function cleanup() {
  const all = await docker<{ Id: string; Names: string[] }[]>("GET", "/containers/json?all=true")
  for (const c of all) {
    // The container itself, its replacement and any "-gantry-old-" leftovers.
    if (c.Names.some((n) => n.startsWith(`/${NAME}`))) await removeContainer(c.Id)
  }
}

test.beforeAll(async () => {
  test.setTimeout(180_000) // the engine can be slow on a busy host
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  const { Id } = await docker<{ Id: string }>("POST", `/containers/create?name=${NAME}`, {
    Image: "alpine:3",
    Cmd: ["sleep", "900"],
    // sleep ignores SIGTERM; don't wait the default 10s on every stop.
    StopTimeout: 1,
    Env: ["GREETING=hello"],
    Labels: { "gantry.e2e": "true", "com.example.kept": "yes" },
    ExposedPorts: { "80/tcp": {} },
    HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT) }] } },
  })
  await docker("POST", `/containers/${Id}/start`)
  originalId = Id
})

test.afterAll(async () => {
  test.setTimeout(180_000)
  await cleanup()
})

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 60_000 })
}

test("admin edits env and ports; the container is recreated with the new config", async ({ page }) => {
  test.setTimeout(240_000)
  await signIn(page)
  await page.goto(`/containers/${originalId}`)

  await page.getByRole("button", { name: "Edit" }).click()
  const dialog = page.getByRole("dialog", { name: `Edit ${NAME}` })
  await expect(dialog.getByLabel("Environment variables")).toHaveValue(/GREETING=hello/)
  await expect(dialog.getByLabel("Port mappings")).toHaveValue(`127.0.0.1:${PORT}:80`)

  // Invalid input is rejected without touching the container and keeps what was typed.
  await dialog.getByLabel("Port mappings").fill("not-a-port")
  await dialog.getByRole("button", { name: "Recreate" }).click()
  await expect(dialog.getByText(/use host:container/)).toBeVisible()
  await expect(dialog.getByLabel("Port mappings")).toHaveValue("not-a-port")

  const env = await dialog.getByLabel("Environment variables").inputValue()
  await dialog.getByLabel("Environment variables").fill(env.replace("GREETING=hello", "GREETING=bonjour"))
  await dialog.getByLabel("Port mappings").fill(`127.0.0.1:${PORT + 1}:80`)
  await dialog.getByRole("button", { name: "Recreate" }).click()

  // The replacement has a new id; the page follows it.
  await expect(page).not.toHaveURL(new RegExp(originalId), { timeout: 180_000 })
  const newId = /\/containers\/([a-f0-9]{64})/.exec(page.url())?.[1]
  expect(newId).toBeTruthy()
  await expect(page.getByText("bonjour")).toBeVisible()
  await expect(page.getByText(`127.0.0.1:${PORT + 1} → 80/tcp`)).toBeVisible()

  const c = await docker<Inspect>("GET", `/containers/${newId}/json`)
  expect(c.Name).toBe(`/${NAME}`)
  expect(c.State.Running).toBe(true)
  expect(c.Config.Env).toContain("GREETING=bonjour")
  expect(c.Config.Env).not.toContain("GREETING=hello")
  expect(c.HostConfig.PortBindings).toEqual({ "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT + 1) }] })
  expect(c.Config.Labels).toMatchObject({ "gantry.e2e": "true", "com.example.kept": "yes" })

  // The old container is gone, and no "-gantry-old-" copy was left behind.
  await expect(docker("GET", `/containers/${originalId}/json`)).rejects.toThrow(/404/)
  const all = await docker<{ Names: string[] }[]>("GET", "/containers/json?all=true")
  expect(all.filter((x) => x.Names.some((n) => n.startsWith(`/${NAME}`))).map((x) => x.Names[0])).toEqual([`/${NAME}`])
})

test("pull & recreate reports whether the image changed", async ({ page }) => {
  test.setTimeout(240_000)
  const all = await docker<{ Id: string; Names: string[] }[]>("GET", "/containers/json?all=true")
  const current = all.find((c) => c.Names.includes(`/${NAME}`))!
  await signIn(page)
  await page.goto(`/containers/${current.Id}`)
  await page.getByRole("button", { name: "Pull & recreate" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Pull & recreate" }).click()
  // alpine:3 is normally current; if upstream just moved the tag it is updated instead.
  await expect(page.getByText(/Already up to date: alpine:3 has not changed|updated to the latest image/)).toBeVisible({
    timeout: 180_000,
  })
})
