import path from "node:path"

import { expect, test, type Page } from "@playwright/test"

import { ADMIN } from "./credentials"
import { docker, dockerAvailable } from "./docker"

// Remote host agent end to end: the agent runs as a container on this host
// (--network host, the host's Docker socket) and connects out to the e2e
// server; Gantry then manages "this host" through the agent's tunnel only.
//
// Instead of building the Gantry image (a full `next build` inside Docker),
// the agent script is bind-mounted into the stock node:24-alpine image and
// started with plain `node`: the image's `agent` command runs the same file.

test.describe.configure({ mode: "serial" })

const RUN_ID = Date.now().toString(36)
const ENV = `gantry-test-a-env-${RUN_ID}`
const AGENT = "gantry-test-a-agent"
const RUN = `gantry-test-a-run-${RUN_ID}`
const STACK = `gantry-test-a-stack-${RUN_ID}`
const BUILD_TAG = `gantry-test-a-build:${RUN_ID}`
const AGENT_IMAGE = "node:24-alpine"
const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock"
const AGENT_DIR = path.resolve("agent")
const SLOW = 180_000

const COMPOSE = `services:
  app:
    image: alpine:3
    command: ["sleep", "600"]
    init: true
    stop_grace_period: 2s
    labels:
      gantry.e2e: "true"
networks:
  default:
    labels:
      gantry.e2e: "true"
`

let environmentId = 0
let key = ""
let runId = ""

type Inspect = { Id: string; State: { Running: boolean } }

async function removeByName(name: string) {
  await docker("DELETE", `/containers/${encodeURIComponent(name)}?force=true&v=true`).catch(() => {})
}

async function ensureImage(ref: string) {
  try {
    await docker("GET", `/images/${encodeURIComponent(ref)}/json`)
  } catch {
    const [image, tag] = ref.split(":")
    await docker("POST", `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`)
  }
}

/** Starts the agent container with `agentKey`, as the generated `docker run` command would. */
async function startAgent(baseURL: string, agentKey: string) {
  await removeByName(AGENT)
  const { Id } = await docker<{ Id: string }>("POST", `/containers/create?name=${AGENT}`, {
    Image: AGENT_IMAGE,
    Cmd: ["node", "/agent/gantry-agent.mjs"],
    Env: [`GANTRY_URL=${baseURL}`, `GANTRY_AGENT_KEY=${agentKey}`, "GANTRY_AGENT_HEALTH_FILE=/tmp/gantry-agent.health"],
    Labels: { "gantry.e2e": "true" },
    HostConfig: {
      NetworkMode: "host",
      Binds: [`${AGENT_DIR}:/agent:ro`, `${SOCKET}:/var/run/docker.sock`],
    },
  })
  await docker("POST", `/containers/${Id}/start`)
  return Id
}

/** The agent container's output (it has no TTY: strip the 8-byte stream headers). */
async function agentLogs() {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    import("node:http").then(({ default: http }) => {
      const req = http.request({ socketPath: SOCKET, path: `/containers/${AGENT}/logs?stdout=1&stderr=1`, method: "GET" }, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => resolve(Buffer.concat(chunks)))
      })
      req.on("error", reject)
      req.end()
    }, reject)
  })
  let out = ""
  for (let off = 0; off + 8 <= raw.length; ) {
    const size = raw.readUInt32BE(off + 4)
    out += raw.subarray(off + 8, off + 8 + size).toString("utf8")
    off += 8 + size
  }
  return out
}

async function cleanup() {
  await removeByName(AGENT)
  await removeByName(RUN)
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${STACK}`] }))
  const containers = await docker<{ Id: string }[]>("GET", `/containers/json?all=true&filters=${filters}`).catch(() => [])
  for (const c of containers) await docker("DELETE", `/containers/${c.Id}?force=true&v=true`).catch(() => {})
  const networks = await docker<{ Id: string }[]>("GET", `/networks?filters=${filters}`).catch(() => [])
  for (const n of networks) await docker("DELETE", `/networks/${n.Id}`).catch(() => {})
  // By tag only (never by id: alpine:3 shares its layers).
  await docker("DELETE", `/images/${encodeURIComponent(BUILD_TAG)}`).catch(() => {})
}

test.beforeAll(async () => {
  test.setTimeout(SLOW)
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  await cleanup()
  await ensureImage(AGENT_IMAGE)
  await ensureImage("alpine:3")
})

test.afterAll(async () => {
  test.setTimeout(SLOW)
  if (await dockerAvailable()) await cleanup()
})

async function signIn(page: Page) {
  await page.goto("/login")
  await page.getByLabel("Username").fill(ADMIN.username)
  await page.getByLabel("Password").fill(ADMIN.password)
  await page.getByRole("button", { name: "Login" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
}

async function switchEnvironment(page: Page, name: string) {
  await page.locator('[data-sidebar="header"]').getByRole("button").first().click()
  await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click()
}

const envRow = (page: Page) => page.getByRole("row", { name: new RegExp(ENV) })

test("admin adds an agent environment; the agent connects with the shown key", async ({ page, baseURL }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  await page.goto("/environments")
  await page.getByRole("button", { name: "Add agent" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Name").fill(ENV)
  await dialog.getByRole("button", { name: "Create" }).click()

  // Shown once: the key and a ready-to-run command that contains it.
  const keyField = dialog.getByLabel("Enrollment key")
  await expect(keyField).toHaveValue(/^gak_\d+_[A-Za-z0-9_-]{43}$/)
  key = await keyField.inputValue()
  environmentId = Number(/^gak_(\d+)_/.exec(key)![1])
  const command = await dialog.getByLabel("Docker run command").inputValue()
  expect(command).toContain("docker run -d --name gantry-agent --restart unless-stopped")
  expect(command).toContain("-v /var/run/docker.sock:/var/run/docker.sock")
  expect(command).toContain(`-e GANTRY_AGENT_KEY=${key}`)
  expect(command).toContain(`-e GANTRY_URL=${baseURL}`)
  expect(command).toMatch(/ agent$/)
  await expect(dialog.getByTestId("agent-enrollment-status")).toContainText("Waiting for the agent")

  await startAgent(baseURL!, key)
  await expect(dialog.getByTestId("agent-enrollment-status")).toContainText("Agent connected", { timeout: 60_000 })
  await dialog.getByRole("button", { name: "Done" }).click()
  await expect(dialog).toBeHidden()

  await page.reload()
  const row = envRow(page)
  await expect(row).toContainText("connected · Docker")
  await expect(row).toContainText("Agent")
  await expect(row.getByTestId("agent-address")).toContainText("from 127.0.0.1")
  // The key is never shown again.
  expect(await page.content()).not.toContain(key.slice(8))

  const logs = await agentLogs()
  expect(logs).toContain(`connected to ${baseURL} as environment "${ENV}"`)
  expect(logs).not.toContain(key.slice(8))
})

test("containers are listed, created, logged and exec'd into through the agent", async ({ page }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  await switchEnvironment(page, ENV)
  await page.goto("/containers")
  // The agent's own container is on that host too.
  await expect(page.getByRole("link", { name: AGENT, exact: true })).toBeVisible({ timeout: 60_000 })

  // Created and started by Gantry, through the tunnel.
  await page.getByRole("button", { name: "Add container" }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByLabel("Image").fill("alpine:3")
  await dialog.getByLabel("Name").fill(RUN)
  await dialog.getByLabel("Command").fill('sh -c "while true; do date +tick-%s; sleep 1; done"')
  await dialog.getByText("Pull image first").click()
  await dialog.getByRole("button", { name: "Create" }).click()
  await expect(dialog).toBeHidden({ timeout: 60_000 })
  const created = await docker<Inspect>("GET", `/containers/${RUN}/json`)
  expect(created.State.Running).toBe(true)
  runId = created.Id

  // Logs keep coming in (the page follows them).
  await page.goto(`/containers/${runId}`)
  const output = page.getByTestId("log-output")
  await expect(output).toContainText(/tick-\d+/, { timeout: 60_000 })
  const count = async () => ((await output.innerText()).match(/tick-\d+/g) ?? []).length
  const first = await count()
  await expect.poll(count, { timeout: 30_000 }).toBeGreaterThan(first)

  // A hijacked exec connection, both ways.
  await page.goto(`/containers/${runId}?tab=console`)
  await page.getByRole("button", { name: "Connect" }).click()
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("exec-terminal").click()
  await page.keyboard.type("echo agent-$((40 + 2))")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("exec-terminal").locator(".xterm-rows")).toContainText("agent-42")
  await page.getByRole("button", { name: "Disconnect" }).click()

  // Docker events stream through the tunnel too (Server-Sent Events to the browser).
  type Probe = { status: string; events: { id: string; action: string }[] }
  await page.evaluate(() => {
    const w = window as unknown as { __probe: Probe }
    w.__probe = { status: "", events: [] }
    const es = new EventSource("/api/events")
    es.addEventListener("status", (e) => (w.__probe.status = JSON.parse((e as MessageEvent).data).status))
    es.addEventListener("docker", (e) => w.__probe.events.push(JSON.parse((e as MessageEvent).data)))
  })
  const probe = () => page.evaluate(() => (window as unknown as { __probe: Probe }).__probe)
  await expect.poll(async () => (await probe()).status, { timeout: 30_000 }).toBe("connected")
  // SIGWINCH: an event, but the container keeps running.
  await docker("POST", `/containers/${runId}/kill?signal=SIGWINCH`)
  await expect
    .poll(async () => (await probe()).events.some((e) => e.id === runId && e.action === "kill"), { timeout: 30_000 })
    .toBe(true)
})

test("measures the tunnel: list latency and a 50 MB download", async ({ page, context, baseURL }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  // 50 MiB of random data in the container (through the host socket, not measured).
  const exec = await docker<{ Id: string }>("POST", `/containers/${runId}/exec`, {
    Cmd: ["sh", "-c", "head -c 52428800 /dev/urandom > /big.bin"],
  })
  await docker("POST", `/exec/${exec.Id}/start`, { Detach: false, Tty: false })

  const measure = async (envId: number) => {
    await context.addCookies([{ name: "gantry_env", value: String(envId), url: baseURL! }])
    const times: number[] = []
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now()
      const res = await page.request.get("/api/v1/containers")
      expect(res.ok()).toBe(true)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const t0 = performance.now()
    const res = await page.request.get(`/api/files/download?container=${runId}&path=/big.bin`, { timeout: 120_000 })
    expect(res.ok()).toBe(true)
    const body = await res.body()
    const seconds = (performance.now() - t0) / 1000
    expect(body.length).toBe(52428800)
    return { median: times[7], p90: times[13], mbps: 50 / seconds, seconds }
  }
  const local = await measure(1)
  const agent = await measure(environmentId)
  const line = (name: string, m: typeof local) =>
    `${name}: list containers median ${m.median.toFixed(0)} ms (p90 ${m.p90.toFixed(0)} ms); 50 MiB download ${m.seconds.toFixed(2)} s = ${m.mbps.toFixed(1)} MiB/s`
  console.log(`[agent benchmark] ${line("local socket", local)}`)
  console.log(`[agent benchmark] ${line("agent tunnel", agent)}`)
  test.info().annotations.push({ type: "benchmark", description: `${line("local socket", local)} | ${line("agent tunnel", agent)}` })
  await context.addCookies([{ name: "gantry_env", value: String(environmentId), url: baseURL! }])
})

test("a compose stack deploys through the agent", async ({ page }) => {
  test.setTimeout(300_000)
  await signIn(page)
  await switchEnvironment(page, ENV)
  await page.goto("/stacks")
  await page.getByRole("link", { name: "Add stack" }).click()
  await page.getByLabel("Name").fill(STACK)
  await page.getByLabel("Compose file").fill(COMPOSE)
  await page.getByRole("button", { name: "Create & deploy" }).click()
  await expect(page).toHaveURL(/\/stacks\/\d+$/, { timeout: 120_000 })
  const header = page.getByRole("main").getByRole("heading", { level: 2, name: STACK })
  await expect(header).toContainText("running", { timeout: 120_000 })
  await expect(header).toContainText("1/1")
  await expect(page.getByTestId("stack-output")).toContainText("up -d --remove-orphans")

  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${STACK}`] }))
  const [container] = await docker<{ State: string; Command: string }[]>("GET", `/containers/json?all=true&filters=${filters}`)
  expect(container.State).toBe("running")

  await page.getByRole("button", { name: "Down", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Down", exact: true }).click()
  await expect(header).toContainText("not deployed", { timeout: 120_000 })
  expect(await docker<unknown[]>("GET", `/containers/json?all=true&filters=${filters}`)).toHaveLength(0)
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page).toHaveURL(/\/stacks$/, { timeout: 120_000 })
})

test("an image builds through the agent, streaming the context up and the log back", async ({ page }) => {
  test.setTimeout(600_000)
  await signIn(page)
  await switchEnvironment(page, ENV)
  await page.goto("/images/build")
  await expect(page.getByRole("button", { name: "Build image" })).toBeEnabled({ timeout: 60_000 })
  await page.getByRole("textbox", { name: "Dockerfile", exact: true }).fill('FROM alpine:3\nRUN echo "gantry-test-a built through the agent"\n')
  await page.getByLabel("Tags").fill(BUILD_TAG)
  await page.getByRole("button", { name: "Build image" }).click()
  const log = page.getByRole("log", { name: "Build log" })
  await expect(log).toContainText("gantry-test-a built through the agent", { timeout: 300_000 })
  await expect(page.getByTestId("stream-result")).toContainText("Build succeeded", { timeout: 300_000 })
  const inspect = await docker<{ RepoTags: string[] }>("GET", `/images/${encodeURIComponent(BUILD_TAG)}/json`)
  expect(inspect.RepoTags).toContain(BUILD_TAG)
})

test("rotating the key disconnects the old agent; the new key works", async ({ page, baseURL }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  await page.goto("/environments")
  await envRow(page).getByRole("button", { name: "Rotate agent key" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Rotate key" }).click()
  const dialog = page.getByRole("dialog")
  const keyField = dialog.getByLabel("Enrollment key")
  await expect(keyField).toHaveValue(/^gak_\d+_/)
  const newKey = await keyField.inputValue()
  expect(newKey).not.toBe(key)
  expect(newKey.startsWith(`gak_${environmentId}_`)).toBe(true)

  // The old agent was told and dropped at once.
  await expect.poll(agentLogs, { timeout: 30_000 }).toContain("Gantry ended the session: the agent key was rotated")
  await expect(dialog.getByTestId("agent-enrollment-status")).toContainText("Waiting for the agent")
  // Its key is refused from now on.
  const old = await page.request.get("/api/agent/connect", {
    headers: { Authorization: `Bearer ${key}`, "X-Gantry-Agent-Info": Buffer.from('{"protocol":1}').toString("base64url") },
  })
  expect(old.status()).toBe(401)

  await startAgent(baseURL!, newKey)
  await expect(dialog.getByTestId("agent-enrollment-status")).toContainText("Agent connected", { timeout: 60_000 })
  await dialog.getByRole("button", { name: "Done" }).click()
  await page.reload()
  await expect(envRow(page)).toContainText("connected · Docker")
  key = newKey
})

test("deleting the environment drops the agent and refuses its key", async ({ page }) => {
  test.setTimeout(SLOW)
  await signIn(page)
  await page.goto("/environments")
  await envRow(page).getByRole("button", { name: "Remove environment" }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
  await expect(envRow(page)).toHaveCount(0)
  await expect.poll(agentLogs, { timeout: 30_000 }).toContain("the environment was deleted")
  const res = await page.request.get("/api/agent/connect", {
    headers: { Authorization: `Bearer ${key}`, "X-Gantry-Agent-Info": Buffer.from('{"protocol":1}').toString("base64url") },
  })
  expect(res.status()).toBe(401)
})
