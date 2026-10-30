import crypto from "node:crypto"

import { expect, test, type Page } from "@playwright/test"

import { createRepo, startGitServer, type GitServer } from "../helpers/git-http-server"
import { ADMIN } from "./credentials"
import { docker, dockerAvailable } from "./docker"

// Git-backed stacks end to end, without the internet: a private repository is
// served from this process over http on 127.0.0.1 (the server runs with
// GANTRY_TEST_ALLOW_HTTP_GIT=1, see playwright.config.ts).
test.describe.configure({ mode: "serial" })

const STACK = `gantry-test-m-git-${Date.now().toString(36)}`
const GIT_USER = "gantry-e2e"
const GIT_TOKEN = `e2e-git-token-${crypto.randomBytes(8).toString("hex")}`

// Relative env_file: resolves inside the checkout (deploy/app.env).
// pull_policy: never keeps "docker compose pull" offline (alpine:3 is local).
const COMPOSE = `services:
  app:
    image: alpine:3
    pull_policy: never
    command: ["sleep", "\${SLEEP}"]
    init: true
    stop_grace_period: 2s
    env_file: app.env
    labels:
      gantry.e2e: "true"
networks:
  default:
    labels:
      gantry.e2e: "true"
`

let server: GitServer
let repo: Awaited<ReturnType<typeof createRepo>>
const shas: string[] = []

test.beforeAll(async () => {
  test.skip(!(await dockerAvailable()), "Docker socket not available")
  server = await startGitServer({ auth: { username: GIT_USER, password: GIT_TOKEN } })
  repo = await createRepo(server, "e2e-app")
  shas.push(await repo.commit({ "deploy/compose.yaml": COMPOSE, "deploy/app.env": "REV=1\n" }, "First commit"))
  // A branch the stack doesn't follow.
  await repo.commit({ "deploy/app.env": "REV=other\n" }, "Other branch", "other")
})

test.afterAll(async () => {
  test.setTimeout(120_000)
  await server?.close()
  await repo?.remove()
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

/** REV from the running container's environment (set by the repo's app.env). */
async function containerRev() {
  const filters = encodeURIComponent(JSON.stringify({ label: [`com.docker.compose.project=${STACK}`] }))
  const [c] = await docker<{ Id: string; State: string }[]>("GET", `/containers/json?filters=${filters}`)
  if (!c) return null
  const info = await docker<{ Config: { Env: string[] } }>("GET", `/containers/${c.Id}/json`)
  return info.Config.Env.find((e) => e.startsWith("REV="))?.slice(4) ?? null
}

const header = (page: Page) => page.getByRole("main").getByRole("heading", { level: 2, name: STACK })
const commitLine = (page: Page) => page.getByTestId("git-commit")

/** Reloads until the deployed commit shown on the page is `sha`. */
async function expectDeployed(page: Page, sha: string) {
  await expect
    .poll(
      async () => {
        await page.reload()
        return (await commitLine(page).textContent()) ?? ""
      },
      { timeout: 300_000, intervals: [1_000, 2_000, 3_000] }
    )
    .toContain(sha.slice(0, 7))
}

function githubDelivery(url: string, secret: string, ref: string, sig?: string) {
  const body = JSON.stringify({ ref, after: shas.at(-1), repository: { full_name: "e2e/app" } })
  const signature = sig ?? `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`
  // Plain fetch: no session cookie, like a real Git provider.
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": "push", "X-Hub-Signature-256": signature },
    body,
  })
}

test("Git stack: create from a private repo, webhook redeploys, pull & redeploy", async ({ page }) => {
  // Generous: on a busy host a single compose up can take a minute or two.
  test.setTimeout(1_500_000)
  await signIn(page)

  await page.goto("/stacks/new")
  await page.getByRole("tab", { name: "Git repository" }).click()
  // Role locators skip pages Next keeps hidden in the DOM (e.g. the login form).
  const field = (name: string) => page.getByRole("textbox", { name, exact: true })
  await field("Name").fill(STACK)
  await field("Repository URL").fill(server.url("e2e-app"))
  await field("Branch, tag or commit").fill("main")
  await field("Compose file path").fill("deploy/compose.yaml")
  await field("Username").fill(GIT_USER)
  // Password inputs have no textbox role.
  await page.getByLabel("Access token", { exact: true }).fill(GIT_TOKEN)
  await field("Environment variables").fill("SLEEP=600\n")
  await page.getByRole("button", { name: "Create & deploy" }).click()

  await expect(page).toHaveURL(/\/stacks\/\d+$/, { timeout: 300_000 })
  const stackUrl = page.url()
  await expect(header(page)).toContainText("running")
  await expect(header(page)).toContainText("1/1")
  await expect(commitLine(page)).toContainText(shas[0].slice(0, 7))
  await expect(commitLine(page)).toContainText("First commit")
  await expect(page.getByText("Credentials: stored (encrypted)")).toBeVisible()
  // env_file: app.env resolved inside the repository; ${SLEEP} came from Gantry's .env.
  expect(await containerRev()).toBe("1")
  await expect(page.getByTestId("stack-output")).toContainText("up -d --remove-orphans")

  // The token is stored but never sent to the browser (HTML or RSC payload).
  expect(await page.content()).not.toContain(GIT_TOKEN)
  const raw = await page.request.get(stackUrl)
  expect(await raw.text()).not.toContain(GIT_TOKEN)
  await page.getByRole("button", { name: "Edit repository" }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByLabel("Access token", { exact: true })).toHaveValue("")
  expect(await page.content()).not.toContain(GIT_TOKEN)
  await dialog.getByRole("button", { name: "Cancel" }).click()

  // Webhook: enable, read URL and the one-time secret.
  await page.getByRole("button", { name: "Enable webhook" }).click()
  const secretEl = page.getByTestId("webhook-secret")
  await expect(secretEl).toBeVisible()
  const secret = (await secretEl.textContent())!.trim()
  const hookUrl = (await page.getByTestId("webhook-url").textContent())!.trim()
  expect(hookUrl).toMatch(/\/api\/webhooks\/stacks\/[A-Za-z0-9_-]{32}$/)
  expect(secret.length).toBeGreaterThanOrEqual(32)

  shas.push(await repo.commit({ "deploy/app.env": "REV=2\n" }, "Second commit"))

  // Only POST is public; anything else still needs a session.
  expect((await fetch(hookUrl)).status).toBe(401)
  // Invalid signature: rejected, nothing deployed.
  const bad = await githubDelivery(hookUrl, secret, "refs/heads/main", `sha256=${"0".repeat(64)}`)
  expect(bad.status).toBe(401)
  // Valid signature for another branch: ignored.
  const other = await githubDelivery(hookUrl, secret, "refs/heads/other")
  expect(other.status).toBe(200)
  expect(await other.json()).toMatchObject({ status: "ignored" })
  // Wait out the queue's debounce: still on the first commit.
  await page.waitForTimeout(5_000)
  await page.reload()
  await expect(commitLine(page)).toContainText(shas[0].slice(0, 7))
  expect(await containerRev()).toBe("1")

  // Valid GitHub delivery for main: 202 at once, redeploy in the background.
  const ok = await githubDelivery(hookUrl, secret, "refs/heads/main")
  expect(ok.status).toBe(202)
  expect(await ok.json()).toMatchObject({ status: "accepted" })
  await expectDeployed(page, shas[1])
  await expect(commitLine(page)).toContainText("Second commit")
  expect(await containerRev()).toBe("2")
  await expect(page.getByText(/Pull & redeploy by webhook/)).toBeVisible()

  // GitLab-style delivery (X-Gitlab-Token) for the next commit.
  shas.push(await repo.commit({ "deploy/app.env": "REV=3\n" }, "Third commit"))
  const gitlab = await fetch(hookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gitlab-Event": "Push Hook", "X-Gitlab-Token": secret },
    body: JSON.stringify({ ref: "refs/heads/main", after: shas[2] }),
  })
  expect(gitlab.status).toBe(202)
  await expectDeployed(page, shas[2])
  expect(await containerRev()).toBe("3")

  // Manual "Pull & redeploy": deploys a new commit, then has nothing to do.
  shas.push(await repo.commit({ "deploy/app.env": "REV=4\n" }, "Fourth commit"))
  await page.getByRole("button", { name: "Pull & redeploy" }).click()
  await expect(commitLine(page)).toContainText(shas[3].slice(0, 7), { timeout: 300_000 })
  expect(await containerRev()).toBe("4")
  await page.getByRole("button", { name: "Pull & redeploy" }).click()
  await expect(page.getByText(/nothing to redeploy/).first()).toBeVisible({ timeout: 60_000 })

  // Delete the stack (compose down + files).
  await page.getByRole("button", { name: "Delete", exact: true }).click()
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click()
  await expect(page).toHaveURL(/\/stacks$/, { timeout: 300_000 })
  await expect(page.getByRole("link", { name: STACK })).toHaveCount(0)
  // The webhook is gone with it.
  expect((await githubDelivery(hookUrl, secret, "refs/heads/main")).status).toBe(404)
})
