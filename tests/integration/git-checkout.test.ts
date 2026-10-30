import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { OutputBuffer } from "@/lib/server/stacks/compose"
import { GitError, headCommit, readComposeFile, remoteCommit, syncCheckout } from "@/lib/server/stacks/git"
import { createRepo, startGitServer, type GitServer } from "../helpers/git-http-server"

// Real git against a local smart-HTTP server (git http-backend) that requires
// Basic auth. A wrapper around git records every argv and environment, so we
// can assert the token never shows up there, in .git or in request URLs.

const USER = "gantry-test"
const TOKEN = "tok_IntegrationSecret_9f8e7d6c5b4a"

let server: GitServer
let repo: Awaited<ReturnType<typeof createRepo>>
let tmp: string
let spyLog: string
let firstSha: string
const prevEnv = { flag: process.env.GANTRY_TEST_ALLOW_HTTP_GIT, cli: process.env.GIT_CLI }

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p)))
    else if (e.isFile()) out.push(p)
  }
  return out
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gantry-test-gitit-"))
  spyLog = path.join(tmp, "spy.log")
  const wrapper = path.join(tmp, "git-spy")
  await fs.writeFile(
    wrapper,
    `#!/bin/sh\n{ printf 'ARGV:'; printf ' %s' "$@"; printf '\\n'; env | sed 's/^/ENV:/'; } >> '${spyLog}'\nexec git "$@"\n`,
    { mode: 0o755 }
  )
  process.env.GIT_CLI = wrapper
  process.env.GANTRY_TEST_ALLOW_HTTP_GIT = "1"

  server = await startGitServer({ auth: { username: USER, password: TOKEN } })
  repo = await createRepo(server, "app")
  firstSha = await repo.commit(
    {
      "deploy/compose.yaml": "services:\n  app:\n    image: alpine:3\n    env_file: app.env\n",
      "deploy/app.env": "REV=1\n",
      "escape.yml": "services: {}\n",
    },
    "First commit"
  )
  await fs.symlink("/etc/hostname", path.join(repo.work, "link.yml"))
  await fs.symlink("../escape.yml", path.join(repo.work, "deploy", "inside-link.yml"))
  firstSha = await repo.commit({}, "Add links")
})

afterAll(async () => {
  process.env.GANTRY_TEST_ALLOW_HTTP_GIT = prevEnv.flag
  if (prevEnv.cli === undefined) delete process.env.GIT_CLI
  else process.env.GIT_CLI = prevEnv.cli
  await server?.close()
  await repo?.remove()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe("git checkout of a private repository", () => {
  const stack = () => path.join(tmp, "stack")
  const source = () => ({ url: server.url("app"), ref: "main", credentials: { username: USER, token: TOKEN } })

  it("clones with credentials and reports the commit", async () => {
    const out = new OutputBuffer()
    const commit = await syncCheckout(stack(), source(), out)
    expect(commit.sha).toBe(firstSha)
    expect(commit.subject).toBe("Add links")
    expect(commit.author).toBe("Gantry Test")
    expect(Date.parse(commit.date)).not.toBeNaN()
    expect(out.toString()).toContain(`Checked out ${firstSha.slice(0, 7)}`)
    expect(await headCommit(stack())).toEqual(commit)
  })

  it("keeps the token out of argv, environments, .git, output and URLs", async () => {
    const log = await fs.readFile(spyLog, "utf8")
    expect(log).toContain("ARGV: fetch")
    expect(log).not.toContain(TOKEN)
    for (const file of await walk(path.join(stack(), "repo", ".git"))) {
      expect(await fs.readFile(file, "latin1"), file).not.toContain(TOKEN)
    }
    const config = await fs.readFile(path.join(stack(), "repo", ".git", "config"), "utf8")
    expect(config).not.toContain("127.0.0.1")
    expect(server.requests.join("\n")).not.toContain(TOKEN)
    // It was sent the way the server asked for it.
    expect(server.authHeaders).toContain(`Basic ${Buffer.from(`${USER}:${TOKEN}`).toString("base64")}`)
    // The temp dir with the credential file is gone.
    const leftovers = (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("gantry-git-"))
    for (const d of leftovers) {
      const files = await walk(path.join(os.tmpdir(), d)).catch(() => [])
      for (const f of files) expect(await fs.readFile(f, "utf8").catch(() => "")).not.toContain(TOKEN)
    }
  })

  it("fails cleanly with a wrong token or without credentials", async () => {
    const wrong = { ...source(), credentials: { username: USER, token: "wrong-token-123" } }
    await expect(syncCheckout(path.join(tmp, "wrong"), wrong, new OutputBuffer())).rejects.toThrow(GitError)
    const err = await syncCheckout(path.join(tmp, "none"), { ...source(), credentials: null }, new OutputBuffer()).catch((e: Error) => e)
    expect(err).toBeInstanceOf(GitError)
    expect((err as Error).message).toMatch(/fetch failed/)
  })

  it("fails for a missing ref", async () => {
    await expect(syncCheckout(stack(), { ...source(), ref: "nope" }, new OutputBuffer())).rejects.toThrow(/fetch failed/)
  })

  it("reads the compose file inside the checkout and refuses escapes", async () => {
    const file = await readComposeFile(stack(), "deploy/compose.yaml")
    expect(file.file).toBe(path.join("repo", "deploy", "compose.yaml"))
    expect(file.text).toContain("env_file: app.env")
    // A symlink that stays inside the repository is fine.
    await expect(readComposeFile(stack(), "deploy/inside-link.yml")).resolves.toMatchObject({ text: "services: {}\n" })
    await expect(readComposeFile(stack(), "link.yml")).rejects.toThrow(/outside the repository/)
    await expect(readComposeFile(stack(), "missing.yml")).rejects.toThrow(/not found/)
    await expect(readComposeFile(stack(), "deploy")).rejects.toThrow()
  })

  it("moves to new commits and keeps untracked files (data)", async () => {
    await fs.writeFile(path.join(stack(), "repo", "deploy", "data.txt"), "keep me")
    await fs.writeFile(path.join(stack(), "repo", "deploy", "app.env"), "LOCAL EDIT\n")
    const second = await repo.commit({ "deploy/app.env": "REV=2\n" }, "Second commit")
    expect(await remoteCommit(source())).toBe(second)
    const commit = await syncCheckout(stack(), source(), new OutputBuffer())
    expect(commit.sha).toBe(second)
    expect(await fs.readFile(path.join(stack(), "repo", "deploy", "app.env"), "utf8")).toBe("REV=2\n")
    expect(await fs.readFile(path.join(stack(), "repo", "deploy", "data.txt"), "utf8")).toBe("keep me")
    expect(await remoteCommit({ ...source(), ref: "missing" })).toBeNull()
  })
})
