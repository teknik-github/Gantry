import "server-only"

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { allowHttpLoopback } from "@/lib/git-stacks"
import { OutputBuffer } from "@/lib/server/stacks/compose"
import { MAX_COMPOSE_BYTES } from "@/lib/stacks"

// Runs the `git` CLI for Git-backed stacks. Like compose, always spawned with
// an argument array (never a shell) and a minimal environment.
//
// Credentials never appear in argv, in the environment, in the stored URL or
// in .git/config: for each run they are written to a file in a private
// mkdtemp dir (0700, file 0600) and handed to git by a credential helper that
// `cat`s that file. The helper is configured through GIT_CONFIG_* variables
// (env-scoped config, not argv, not .git/config) and only names the file's
// path. The dir is removed when the command ends. A helper rather than
// GIT_ASKPASS: askpass needs an executable script, which fails when the temp
// dir is mounted noexec; the `!` helper is run by /bin/sh. A helper rather
// than http.extraHeader: git only sends credentials after the server asks
// for them, and never to another host after a redirect.

/** Checkout directory inside the stack's directory. */
export const CHECKOUT_DIR = "repo"

const FETCH_TIMEOUT_MS = 5 * 60_000
const QUICK_TIMEOUT_MS = 60_000
/** Kept from each git command's output for the stack's run log. */
const MAX_GIT_OUTPUT = 64 * 1024
/** Upper bound on stdout parsed by Gantry (ls-remote, log). */
const MAX_STDOUT = 1024 * 1024

export type GitCredentials = { username: string; token: string }
export type GitSource = { url: string; ref: string; credentials: GitCredentials | null }
export type CommitInfo = { sha: string; subject: string; author: string; date: string }

/** Failure with a message that is safe to show (credentials redacted). */
export class GitError extends Error {}

/** The compose file path doesn't lead to a usable file in the checkout. */
export class ComposeFileError extends GitError {}

/** Username/token checks: they end up in git's credential protocol (line based). */
export function checkCredentials(username: string, token: string): string | null {
  if (!username && !token) return null
  if (!username) return "Enter the username that goes with the token"
  if (!token) return "Enter the access token or password"
  if (username.length > 255 || !/^[^\s:\0]+$/.test(username)) return "The username can't contain spaces or ':'"
  if (token.length > 1024 || /[\s\0]/.test(token)) return "The token can't contain whitespace"
  return null
}

/** Private temp dir (HOME for git, holds the credential file); the caller removes it. */
async function makeTempHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gantry-git-"))
  // The path is embedded in a shell helper; refuse anything that would need quoting.
  if (!/^[A-Za-z0-9._/-]+$/.test(dir)) {
    await fs.rm(dir, { recursive: true, force: true })
    throw new GitError("The temp directory path contains unsupported characters (set TMPDIR)")
  }
  return dir
}

/**
 * Git config for one run, passed as GIT_CONFIG_COUNT/KEY_n/VALUE_n. Resets
 * credential helpers (nothing from a mounted config can store the token),
 * allows only https (plus http for loopback in tests), disables hooks.
 */
export function gitConfigEntries(opts: { credentialFile: string | null; allowHttp: boolean }): [string, string][] {
  const entries: [string, string][] = [
    // An empty value resets the helper list.
    ["credential.helper", ""],
    ["protocol.allow", "never"],
    ["protocol.https.allow", "always"],
    ["core.hooksPath", "/dev/null"],
    ["advice.detachedHead", "false"],
    ["init.defaultBranch", "main"],
    ["gc.autoDetach", "false"],
    // Give up on stalled transfers (bytes/s over seconds).
    ["http.lowSpeedLimit", "1000"],
    ["http.lowSpeedTime", "60"],
  ]
  if (opts.allowHttp) entries.push(["protocol.http.allow", "always"])
  if (opts.credentialFile) {
    // Answers `get` only; `store`/`erase` are ignored.
    entries.push(["credential.helper", `!f() { test "$1" = get && cat '${opts.credentialFile}'; }; f`])
  }
  return entries
}

/** Environment for git: nothing from Gantry's own environment except PATH/locale. */
export function gitEnv(
  home: string,
  config: [string, string][],
  base: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: base.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: home,
    // No system/global config, no prompts, English messages.
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_COUNT: String(config.length),
  }
  config.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  if (base.TZ) env.TZ = base.TZ
  return env
}

/** Replaces every occurrence of the secrets in `text`. */
export function redact(text: string, secrets: string[]) {
  let out = text
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("***")
  return out
}

type GitRun = { code: number | null; stdout: string; timedOut: boolean }

function spawnGit(
  args: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; out: OutputBuffer; secrets: string[]; captureStdout?: boolean }
): Promise<GitRun> {
  return new Promise((resolve) => {
    let stdout = ""
    let timedOut = false
    let settled = false
    const log = new OutputBuffer(MAX_GIT_OUTPUT)
    const child = spawn(/* turbopackIgnore: true */ process.env.GIT_CLI || "git", args, {
      cwd: /* turbopackIgnore: true */ opts.cwd,
      env: opts.env as unknown as NodeJS.ProcessEnv,
      shell: false,
      // Own process group, so a timeout also stops git-remote-https & co.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d: string) => {
      if (opts.captureStdout) {
        if (stdout.length < MAX_STDOUT) stdout += d.slice(0, MAX_STDOUT - stdout.length)
      } else log.append(d)
    })
    child.stderr.on("data", (d: string) => log.append(d))

    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    let killTimer: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      kill("SIGTERM")
      killTimer = setTimeout(() => kill("SIGKILL"), 5_000)
    }, Math.max(1, opts.timeoutMs))

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      const text = redact(log.toString(), opts.secrets)
      if (text) opts.out.append(text.endsWith("\n") ? text : `${text}\n`)
      resolve({ code, stdout: redact(stdout, opts.secrets), timedOut })
    }
    child.on("error", (err: NodeJS.ErrnoException) => {
      opts.out.append(
        err.code === "ENOENT"
          ? "The git CLI was not found. Install git (the Gantry image includes it).\n"
          : `Failed to run git: ${err.message}\n`
      )
      finish(127)
    })
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : null)))
  })
}

/**
 * Runs one or more git commands with the source's credentials available to
 * git (and nowhere else) for their duration.
 */
async function withGit<T>(
  source: Pick<GitSource, "url" | "credentials">,
  fn: (git: (args: string[], o: { cwd: string; timeoutMs?: number; out?: OutputBuffer; captureStdout?: boolean }) => Promise<GitRun>, home: string) => Promise<T>
): Promise<T> {
  const home = await makeTempHome()
  const secrets = source.credentials ? [source.credentials.token] : []
  try {
    let credentialFile: string | null = null
    if (source.credentials) {
      credentialFile = path.join(home, "credentials")
      await fs.writeFile(
        credentialFile,
        `username=${source.credentials.username}\npassword=${source.credentials.token}\n`,
        { mode: 0o600 }
      )
    }
    const allowHttp = allowHttpLoopback() && source.url.startsWith("http://")
    const env = gitEnv(home, gitConfigEntries({ credentialFile, allowHttp }))
    return await fn(
      (args, o) =>
        spawnGit(args, {
          cwd: o.cwd,
          env,
          timeoutMs: o.timeoutMs ?? QUICK_TIMEOUT_MS,
          out: o.out ?? new OutputBuffer(MAX_GIT_OUTPUT),
          secrets,
          captureStdout: o.captureStdout,
        }),
      home
    )
  } finally {
    await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
}

function failure(step: string, run: GitRun, out: OutputBuffer, timeoutMs: number) {
  if (run.timedOut) return new GitError(`git ${step} timed out after ${Math.round(timeoutMs / 1000)} s`)
  // The last "fatal:"/"error:" line is the useful part (e.g. authentication failed).
  const lines = out.toString().split("\n").map((l) => l.trim()).filter(Boolean)
  const reason = [...lines].reverse().find((l) => /^(fatal|error|remote):/i.test(l)) ?? lines.at(-1) ?? `exit code ${run.code}`
  return new GitError(`git ${step} failed: ${reason.slice(0, 300)}`)
}

export function checkoutDir(stackDir: string) {
  return path.join(/* turbopackIgnore: true */ stackDir, CHECKOUT_DIR)
}

export async function hasCheckout(stackDir: string) {
  return fs.stat(path.join(/* turbopackIgnore: true */ checkoutDir(stackDir), ".git")).then(
    (st) => st.isDirectory(),
    () => false
  )
}

/**
 * Shallow-fetches `source.ref` into the stack's checkout and checks it out
 * (detached, tracked files forced to the commit; untracked files such as
 * data in bind-mounted folders stay). Git's output goes to `out`.
 */
export async function syncCheckout(stackDir: string, source: GitSource, out: OutputBuffer): Promise<CommitInfo> {
  const repo = checkoutDir(stackDir)
  await fs.mkdir(repo, { recursive: true, mode: 0o700 })
  return withGit(source, async (git) => {
    if (!(await hasCheckout(stackDir))) {
      const init = await git(["init", "--quiet", "."], { cwd: repo, out })
      if (init.code !== 0) throw failure("init", init, out, QUICK_TIMEOUT_MS)
    }
    // The URL is passed per fetch, never stored as a remote.
    out.append(`$ git fetch --depth=1 ${source.url} ${source.ref}\n`)
    const fetch = await git(
      ["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--no-progress", "--", source.url, source.ref],
      { cwd: repo, out, timeoutMs: FETCH_TIMEOUT_MS }
    )
    if (fetch.code !== 0) throw failure("fetch", fetch, out, FETCH_TIMEOUT_MS)
    const checkout = await git(["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], { cwd: repo, out })
    if (checkout.code !== 0) throw failure("checkout", checkout, out, QUICK_TIMEOUT_MS)
    const commit = await readHead(repo, git)
    out.append(`Checked out ${commit.sha.slice(0, 7)} ${commit.subject}\n`)
    return commit
  })
}

const LOG_FORMAT = "%H%x00%s%x00%an%x00%aI"

async function readHead(
  repo: string,
  git: (args: string[], o: { cwd: string; captureStdout?: boolean }) => Promise<GitRun>
): Promise<CommitInfo> {
  const res = await git(["log", "-1", `--format=${LOG_FORMAT}`, "HEAD"], { cwd: repo, captureStdout: true })
  const commit = res.code === 0 ? parseCommit(res.stdout) : null
  if (!commit) throw new GitError("Could not read the checked out commit")
  return commit
}

export function parseCommit(text: string): CommitInfo | null {
  const [sha, subject, author, date] = text.replace(/\n$/, "").split("\0")
  if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return null
  return { sha, subject: (subject ?? "").slice(0, 1000), author: (author ?? "").slice(0, 255), date: date ?? "" }
}

/** The commit currently checked out (no network). */
export async function headCommit(stackDir: string): Promise<CommitInfo> {
  return withGit({ url: "", credentials: null }, (git) => readHead(checkoutDir(stackDir), git))
}

/**
 * The commit `source.ref` points at on the remote (git ls-remote), or null
 * when the ref doesn't exist. Commit-pinned refs return the ref itself.
 */
export async function remoteCommit(source: GitSource): Promise<string | null> {
  if (/^[0-9a-f]{40,64}$/.test(source.ref)) return source.ref
  const patterns = source.ref.startsWith("refs/")
    ? [source.ref, `${source.ref}^{}`]
    : [`refs/heads/${source.ref}`, `refs/tags/${source.ref}`, `refs/tags/${source.ref}^{}`]
  return withGit(source, async (git, home) => {
    const out = new OutputBuffer(MAX_GIT_OUTPUT)
    const res = await git(["ls-remote", "--", source.url, ...patterns], { cwd: home, out, captureStdout: true })
    if (res.code !== 0) throw failure("ls-remote", res, out, QUICK_TIMEOUT_MS)
    return pickRemoteRef(res.stdout, source.ref)
  })
}

/** From ls-remote output: the branch, else the peeled tag, else the tag. */
export function pickRemoteRef(text: string, ref: string): string | null {
  const refs = new Map<string, string>()
  for (const line of text.split("\n")) {
    const [sha, name] = line.trim().split(/\s+/)
    if (sha && name && /^[0-9a-f]{40,64}$/.test(sha)) refs.set(name, sha)
  }
  const order = ref.startsWith("refs/")
    ? [`${ref}^{}`, ref]
    : [`refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`]
  for (const name of order) if (refs.has(name)) return refs.get(name)!
  return null
}

/**
 * Resolves the compose file inside the checkout, refusing paths that leave it
 * (symlinks included) and files that aren't regular or are too large.
 * Returns the path relative to the stack dir (for `docker compose -f`) and
 * the file's text.
 */
export async function readComposeFile(stackDir: string, composePath: string): Promise<{ file: string; text: string }> {
  const repo = checkoutDir(stackDir)
  const target = path.join(/* turbopackIgnore: true */ repo, composePath)
  let real: string
  let realRepo: string
  try {
    ;[real, realRepo] = await Promise.all([fs.realpath(target), fs.realpath(repo)])
  } catch {
    throw new ComposeFileError(`${composePath} was not found in the repository`)
  }
  const inside = real.startsWith(realRepo + path.sep)
  const rel = path.relative(realRepo, real)
  if (!inside || rel.split(path.sep)[0] === ".git") {
    throw new ComposeFileError(`${composePath} points outside the repository`)
  }
  const stat = await fs.stat(real)
  if (!stat.isFile()) throw new ComposeFileError(`${composePath} is not a file`)
  if (stat.size > MAX_COMPOSE_BYTES) throw new ComposeFileError(`${composePath} is larger than ${MAX_COMPOSE_BYTES / 1024} KB`)
  const text = await fs.readFile(real, "utf8")
  return { file: path.join(CHECKOUT_DIR, composePath), text }
}
