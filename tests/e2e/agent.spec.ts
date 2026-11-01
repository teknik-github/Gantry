import crypto from "node:crypto"
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
// E2E_AGENT_DIR runs another agent script against this Gantry, e.g. an older
// release to check compatibility (or to measure the tunnel as it was).
const AGENT_DIR = path.resolve(process.env.E2E_AGENT_DIR ?? "agent")
const SLOW = 180_000
// Parity checks through the agent: a Trivy scan and a push to a throwaway registry.
const SCANNER = "aquasec/trivy:0.76.1"
/** The server's TRIVY_CACHE_VOLUME (playwright.config.ts). */
const TRIVY_CACHE = process.env.E2E_TRIVY_CACHE_VOLUME || "gantry-test-s-trivy-cache"
const SCAN_TIMEOUT = 900_000
const REGISTRY = `gantry-test-c-registry-${RUN_ID}`
const REGISTRY_PORT = 17000 + Math.floor(Math.random() * 1000)
const PUSHED_REPO = `localhost:${REGISTRY_PORT}/gantry-test-c/agent`
const PUSHED = `${PUSHED_REPO}:1`

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
let createdTrivyCache = false
let pulledRegistry = false

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
  await removeByName(REGISTRY)
  // By tag only (never by id: alpine:3 shares its layers).
  await docker("DELETE", `/images/${encodeURIComponent(PUSHED)}`).catch(() => {})
  await docker("DELETE", `/images/${encodeURIComponent(BUILD_TAG)}`).catch(() => {})
}

const imageExists = (ref: string) =>
  docker("GET", `/images/${encodeURIComponent(ref)}/json`).then(
    () => true,
    () => false
  )

test.beforeAll(async () => {
  test.setTimeout(SLOW)
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  await cleanup()
  await ensureImage(AGENT_IMAGE)
  await ensureImage("alpine:3")
  createdTrivyCache = !(await docker("GET", `/volumes/${TRIVY_CACHE}`).then(
    () => true,
    () => false
  ))
  pulledRegistry = !(await imageExists("registry:2"))
})

test.afterAll(async () => {
  test.setTimeout(SLOW)
  if (!(await dockerAvailable())) return
  // The agent's log helps when something above failed.
  const logs = await agentLogs().catch(() => "")
  if (logs) console.log(`[agent log]\n${logs.trim().split("\n").slice(-40).join("\n")}`)
  await cleanup()
  // Only what this run brought in: never a cache volume that was there before.
  if (createdTrivyCache && !process.env.E2E_KEEP_TRIVY_CACHE) await docker("DELETE", `/volumes/${TRIVY_CACHE}`).catch(() => {})
  if (pulledRegistry) await docker("DELETE", "/images/registry:2").catch(() => {})
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
  // The switch is a Server Action: wait for it before navigating, or the next
  // page may still be rendered for the previous environment.
  await expect(page.locator('[data-sidebar="header"]')).toContainText(name)
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

  // The environment switcher names the host and its Docker, not agent://<id>.
  const { Name: host } = await docker<{ Name: string }>("GET", "/info")
  const { Version: dockerVersion } = await docker<{ Version: string }>("GET", "/version")
  await page.locator('[data-sidebar="header"]').getByRole("button").first().click()
  const item = page.getByRole("menuitem", { name: new RegExp(`^${ENV}`) })
  await expect(item.getByTestId("switcher-agent")).toHaveText(`${host} · Docker ${dockerVersion} · connected`)
  await expect(item).not.toContainText("agent://")
  await page.keyboard.press("Escape")
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
  await dialog.getByLabel("Image", { exact: true }).fill("alpine:3")
  await dialog.getByLabel("Name", { exact: true }).fill(RUN)
  await dialog.getByLabel("Command", { exact: true }).fill('sh -c "while true; do date +tick-%s; sleep 1; done"')
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

test("measures the tunnel: list latency, a 50 MB download and a 50 MB upload", async ({ page, context, baseURL }) => {
  // E2E_AGENT_BENCH_ROUNDS=n repeats the transfers (alternating local and
  // agent) and reports medians: this host's load makes single runs noisy.
  const rounds = Math.max(1, Number(process.env.E2E_AGENT_BENCH_ROUNDS ?? 1) || 1)
  test.setTimeout(SLOW * rounds)
  await signIn(page)
  // 50 MiB of random data in the container (through the host socket, not measured).
  const exec = await docker<{ Id: string }>("POST", `/containers/${runId}/exec`, {
    Cmd: ["sh", "-c", "head -c 52428800 /dev/urandom > /big.bin"],
  })
  await docker("POST", `/exec/${exec.Id}/start`, { Detach: false, Tty: false })
  const upload = crypto.randomBytes(52428800)

  const selectEnv = (envId: number) => context.addCookies([{ name: "gantry_env", value: String(envId), url: baseURL! }])
  const list = async (envId: number) => {
    await selectEnv(envId)
    const times: number[] = []
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now()
      const res = await page.request.get("/api/v1/containers")
      expect(res.ok()).toBe(true)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    return { median: times[7], p90: times[13] }
  }
  const transfer = async (envId: number) => {
    await selectEnv(envId)
    let t0 = performance.now()
    const res = await page.request.get(`/api/files/download?container=${runId}&path=/big.bin`, { timeout: 120_000 })
    expect(res.ok()).toBe(true)
    expect((await res.body()).length).toBe(52428800)
    const down = (performance.now() - t0) / 1000
    t0 = performance.now()
    const put = await page.request.put(`/api/uploads/files?container=${runId}&path=/tmp&name=up.bin&overwrite=1`, {
      data: upload,
      timeout: 120_000,
    })
    expect(put.status(), await put.text()).toBe(200)
    const up = (performance.now() - t0) / 1000
    return { down, up }
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const lists = { local: await list(1), agent: await list(environmentId) }
  const t = { local: [] as { down: number; up: number }[], agent: [] as { down: number; up: number }[] }
  for (let i = 0; i < rounds; i++) {
    t.local.push(await transfer(1))
    t.agent.push(await transfer(environmentId))
  }
  const line = (name: "local" | "agent", label: string) => {
    const l = lists[name]
    const rate = (s: number[]) => `${median(s).toFixed(2)} s = ${(50 / median(s)).toFixed(1)} MiB/s`
    const all = (s: number[]) => (rounds > 1 ? ` [${s.map((x) => (50 / x).toFixed(1)).join(", ")}]` : "")
    const down = t[name].map((x) => x.down)
    const up = t[name].map((x) => x.up)
    return `${label}: list containers median ${l.median.toFixed(0)} ms (p90 ${l.p90.toFixed(0)} ms); 50 MiB download ${rate(down)}${all(down)}; 50 MiB upload ${rate(up)}${all(up)}`
  }
  console.log(`[agent benchmark] ${line("local", "local socket")}`)
  console.log(`[agent benchmark] ${line("agent", "agent tunnel")}`)
  test.info().annotations.push({ type: "benchmark", description: `${line("local", "local socket")} | ${line("agent", "agent tunnel")}` })

  // The uploaded file arrived whole (checked through the host socket; the
  // exit code is set a moment after the exec's output ends).
  const check = await docker<{ Id: string }>("POST", `/containers/${runId}/exec`, { Cmd: ["sh", "-c", "test $(wc -c < /tmp/up.bin) -eq 52428800"] })
  await docker("POST", `/exec/${check.Id}/start`, { Detach: false, Tty: false })
  await expect.poll(async () => (await docker<{ ExitCode: number | null }>("GET", `/exec/${check.Id}/json`)).ExitCode).toBe(0)
  await selectEnv(environmentId)
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

/**
 * The Images table filtered to one tag's row (the search box only filters
 * once hydrated). Listing images is slow with the containerd store, more so
 * through the tunnel on a busy host.
 */
async function imageRow(page: Page, ref: string) {
  await page.goto("/images")
  const search = page.getByRole("textbox", { name: "Search" })
  const row = page.getByRole("row").filter({ hasText: ref })
  await expect(async () => {
    await search.fill("")
    await search.fill(ref)
    await expect(row).toHaveCount(1, { timeout: 5_000 })
  }).toPass({ timeout: 180_000 })
  return row
}

test("an image is scanned with Trivy through the agent, like on the local socket", async ({ page, context, baseURL }) => {
  test.setTimeout(2 * SCAN_TIMEOUT)
  test.skip(!(await imageExists(SCANNER)), `${SCANNER} is not on this host (pulling it is image-scan.spec.ts's job)`)
  await signIn(page)
  const { Id: imageId, Size: imageSize } = await docker<{ Id: string; Size: number }>("GET", `/images/${encodeURIComponent(BUILD_TAG)}/json`)
  const scan = async (envId: number) => {
    await context.addCookies([{ name: "gantry_env", value: String(envId), url: baseURL! }])
    const row = await imageRow(page, BUILD_TAG)
    const t0 = performance.now()
    await row.getByRole("button", { name: `Scan ${BUILD_TAG}` }).click()
    // Counts, or "no vulnerabilities" for a clean image; a failure fails here.
    await expect(row.getByTestId(/^vuln-(badges|none|failed)$/)).toBeVisible({ timeout: SCAN_TIMEOUT })
    await expect(row.getByTestId("vuln-failed")).toHaveCount(0)
    const seconds = (performance.now() - t0) / 1000
    const res = await page.request.get("/api/image-scans")
    const scans = ((await res.json()) as { scans: { imageId: string; scannedAt: string | null; counts: Record<string, number> }[] }).scans
    const summary = scans.find((x) => x.imageId === imageId)
    expect(summary?.scannedAt).toBeTruthy()
    return { seconds, counts: summary!.counts }
  }
  // Locally first: it also brings Trivy's database up to date in the shared cache volume.
  const local = await scan(1)
  const agent = await scan(environmentId)
  // Same image, same database: the same findings.
  expect(agent.counts).toEqual(local.counts)
  const line = `image ${(imageSize / 1048576).toFixed(1)} MB; from the click to the result: local socket ${local.seconds.toFixed(1)} s, agent tunnel ${agent.seconds.toFixed(1)} s`
  console.log(`[agent scan] ${line}`)
  test.info().annotations.push({ type: "scan", description: line })
  await context.addCookies([{ name: "gantry_env", value: String(environmentId), url: baseURL! }])
})

test("an image is pushed to a registry through the agent", async ({ page }) => {
  test.setTimeout(600_000)
  await ensureImage("registry:2")
  await removeByName(REGISTRY)
  const { Id } = await docker<{ Id: string }>("POST", `/containers/create?name=${REGISTRY}`, {
    Image: "registry:2",
    Labels: { "gantry.e2e": "true" },
    HostConfig: { PortBindings: { "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(REGISTRY_PORT) }] } },
  })
  await docker("POST", `/containers/${Id}/start`)
  await expect.poll(() => fetch(`http://localhost:${REGISTRY_PORT}/v2/`).then((r) => r.status, () => 0), { timeout: 30_000 }).toBe(200)
  // Tagged through the host socket: the push is what goes through the agent.
  await docker("POST", `/images/${encodeURIComponent(BUILD_TAG)}/tag?repo=${encodeURIComponent(PUSHED_REPO)}&tag=1`)

  await signIn(page)
  await switchEnvironment(page, ENV)
  const row = await imageRow(page, BUILD_TAG)
  await expect(row).toContainText(PUSHED, { timeout: 120_000 })
  await row.getByRole("button", { name: /^Push / }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("combobox", { name: "Tag to push" }).click()
  await page.getByRole("option", { name: PUSHED }).click()
  const t0 = performance.now()
  await dialog.getByRole("button", { name: "Push", exact: true }).click()
  await expect(dialog.getByRole("status").filter({ hasText: "Push succeeded" })).toBeVisible({ timeout: 300_000 })
  console.log(`[agent push] ${PUSHED} in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  await expect(dialog.getByRole("log", { name: "Push log" })).toContainText(`Pushing ${PUSHED} to localhost:${REGISTRY_PORT}`)
  await page.keyboard.press("Escape")

  const tags = await fetch(`http://localhost:${REGISTRY_PORT}/v2/gantry-test-c/agent/tags/list`).then((r) => r.json())
  expect(tags).toEqual({ name: "gantry-test-c/agent", tags: ["1"] })
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
  // A click before the table hydrated opens nothing (seen on a busy host): retry until the dialog shows.
  const confirm = page.getByRole("alertdialog")
  await expect(async () => {
    if (!(await confirm.isVisible())) await envRow(page).getByRole("button", { name: "Remove environment" }).click()
    await expect(confirm).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 90_000 })
  await confirm.getByRole("button", { name: "Remove" }).click()
  await expect(envRow(page)).toHaveCount(0)
  await expect.poll(agentLogs, { timeout: 30_000 }).toContain("the environment was deleted")
  const res = await page.request.get("/api/agent/connect", {
    headers: { Authorization: `Bearer ${key}`, "X-Gantry-Agent-Info": Buffer.from('{"protocol":1}').toString("base64url") },
  })
  expect(res.status()).toBe(401)
})
