import "server-only"

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { config } from "@/lib/server/config"
import { KubeError, type KubeTarget } from "@/lib/server/kubernetes/client"
import { stripAnsi } from "@/lib/server/stacks/compose"
import {
  credentialSecrets,
  registryConfigJson,
  repositoriesYaml,
  type HelmRepo,
  type RepoCredentials,
} from "@/lib/server/kubernetes/helm-repos"
import { buildKubeconfig, lineRedactor, redactSecrets, secretsOf } from "@/lib/server/kubernetes/kubeconfig"

// Runs the helm CLI (HELM_BIN, else `helm` on PATH) against a Kubernetes
// environment.
//
// - Credentials: every command gets a fresh private temp dir (mkdtemp,
//   0700; files 0600) holding a kubeconfig generated from the
//   environment's stored credentials, plus repositories.yaml / registry
//   config with the one repository login it needs. The dir is removed in
//   `finally`. Nothing secret is passed in argv or the environment.
// - Isolation: helm's config/cache/data homes live under $DATA_DIR/helm,
//   HOME is the temp dir, and the environment is built from scratch (no
//   GANTRY_SECRET, database passwords, KUBECONFIG of the server...).
// - Output is redacted (credentials, temp paths, anything key-like)
//   before anyone sees it.
// - Every command has a hard timeout: SIGTERM, then SIGKILL, on its own
//   process group. Mutating commands are limited per release (one at a
//   time) and in total (HELM_MAX_OPERATIONS).

export function helmBinary(): string {
  return /* turbopackIgnore: true */ process.env.HELM_BIN || "helm"
}

export function helmHome() {
  const base = path.join(/* turbopackIgnore: true */ config.dataDir, "helm")
  return {
    base,
    config: path.join(base, "config"),
    cache: path.join(base, "cache"),
    data: path.join(base, "data"),
    /** Downloaded repository indexes (public metadata, shared by all commands). */
    repositoryCache: path.join(base, "cache", "repository"),
  }
}

/** Mutating helm commands (install, upgrade, rollback, uninstall) running at once on this server. */
export function maxOperations(): number {
  const n = Number(process.env.HELM_MAX_OPERATIONS)
  return Number.isInteger(n) && n >= 1 && n <= 64 ? n : 4
}
const MAX_QUERIES = 8

/** Kept from a command's stdout when Gantry parses it (search results, default values). */
const MAX_STDOUT = 8 * 1024 * 1024
/** Kept from stderr for error messages. */
const MAX_STDERR = 64 * 1024

export class HelmError extends KubeError {
  constructor(message: string, status = 502) {
    super(message, status)
    this.name = "HelmError"
  }
}

// ---------------------------------------------------------------- binary

const globalForHelm = globalThis as unknown as {
  __gantryHelm?: { locks: Set<string>; operations: number; queries: number; version?: { value: string | null; at: number } }
}
const state = (globalForHelm.__gantryHelm ??= { locks: new Set(), operations: 0, queries: 0 })

/** `helm version --short`, or null when the binary can't be run. Cached; failures are retried after a minute. */
export async function helmVersion(): Promise<string | null> {
  const cached = state.version
  if (cached && (cached.value || Date.now() - cached.at < 60_000)) return cached.value
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gantry-helm-"))
  try {
    const res = await spawnHelm(["version", "--short"], { env: baseEnv(home), timeoutMs: 15_000 })
    const value = res.code === 0 ? res.stdout.trim().split("\n")[0] || "helm" : null
    state.version = { value, at: Date.now() }
    return value
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
}

export const HELM_MISSING =
  "The helm CLI is not available on the Gantry server. Install helm or set HELM_BIN (the Gantry image includes it)."

// ------------------------------------------------------------- workspace

/** Environment for helm: nothing from Gantry's own environment except PATH, proxies, locale and TZ. */
function baseEnv(home: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const dirs = helmHome()
  const env: Record<string, string> = {
    PATH: base.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: home,
    DOCKER_CONFIG: home,
    HELM_CONFIG_HOME: dirs.config,
    HELM_CACHE_HOME: dirs.cache,
    HELM_DATA_HOME: dirs.data,
    HELM_REPOSITORY_CACHE: dirs.repositoryCache,
    HELM_REPOSITORY_CONFIG: path.join(home, "repositories.yaml"),
    HELM_REGISTRY_CONFIG: path.join(home, "registry.json"),
    // Never fall back to a kubeconfig of the server's user.
    KUBECONFIG: path.join(home, "kubeconfig"),
    HELM_DRIVER: "secret",
    HELM_NO_PLUGINS: "1",
    LANG: "C",
    LC_ALL: "C",
  }
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "TZ"]) {
    if (base[k]) env[k] = base[k]!
  }
  return env
}

export type HelmWorkspace = {
  dir: string
  env: Record<string, string>
  /** Arguments every cluster command needs (--kubeconfig). */
  kubeArgs: string[]
  secrets: string[]
  /** Writes a private file (0600) into the workspace and returns its path. */
  write(name: string, content: string): Promise<string>
  /** Redacts output for display. */
  redact(text: string, exactOnly?: boolean): string
}

export type WorkspaceOptions = {
  /** Cluster to talk to (omit for repository-only commands). */
  target?: KubeTarget
  namespace?: string | null
  /** Index repository to list in repositories.yaml. */
  repo?: Pick<HelmRepo, "name" | "url" | "credentials"> | null
  /** Registry login for an oci:// chart. */
  oci?: { host: string; credentials: RepoCredentials | null } | null
}

/**
 * Runs `fn` with a private workspace: kubeconfig, repositories.yaml and
 * registry config for this command only. Removed afterwards, whatever happens.
 */
export async function withHelmWorkspace<T>(opts: WorkspaceOptions, fn: (ws: HelmWorkspace) => Promise<T>): Promise<T> {
  const dirs = helmHome()
  await Promise.all([dirs.config, dirs.data, dirs.repositoryCache].map((d) => fs.mkdir(/* turbopackIgnore: true */ d, { recursive: true, mode: 0o700 })))
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gantry-helm-"))
  try {
    await fs.chmod(dir, 0o700)
    const write = async (name: string, content: string) => {
      const file = path.join(dir, name)
      await fs.writeFile(file, content, { mode: 0o600, flag: "wx" })
      return file
    }
    const env = baseEnv(dir)
    const kubeArgs: string[] = []
    if (opts.target) {
      const file = await write("kubeconfig", buildKubeconfig(opts.target, opts.namespace))
      kubeArgs.push(`--kubeconfig=${file}`)
    }
    await write("repositories.yaml", opts.repo && !opts.repo.url.startsWith("oci://") ? repositoriesYaml(opts.repo) : "apiVersion: \"\"\nrepositories: []\n")
    await write("registry.json", registryConfigJson(opts.oci?.host ?? "", opts.oci?.credentials ?? null))

    const secrets = secretsOf(
      { token: opts.target?.token, key: opts.target?.key, cert: opts.target?.cert },
      [...credentialSecrets(opts.repo?.credentials ?? null), ...credentialSecrets(opts.oci?.credentials ?? null)]
    )
    return await fn({
      dir,
      env,
      kubeArgs,
      secrets,
      write,
      // The temp dir's path says nothing secret, but it is noise: show it as <tmp>.
      redact: (text, exactOnly) => redactSecrets(text, secrets, exactOnly).split(dir).join("<tmp>"),
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------- run

export type HelmRun = { code: number | null; stdout: string; stderr: string; timedOut: boolean }

type SpawnOptions = {
  env: Record<string, string>
  timeoutMs: number
  /** Combined stdout+stderr as it arrives (raw; the caller redacts). Without it, stdout is captured. */
  onOutput?: (text: string) => void
  signal?: AbortSignal
}

function spawnHelm(args: string[], opts: SpawnOptions): Promise<HelmRun> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false
    const child = spawn(helmBinary(), args, {
      cwd: /* turbopackIgnore: true */ opts.env.HOME,
      env: opts.env as unknown as NodeJS.ProcessEnv,
      shell: false,
      // Own process group, so a timeout stops anything helm started too.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d: string) => {
      if (opts.onOutput) opts.onOutput(stripAnsi(d))
      else if (stdout.length < MAX_STDOUT) stdout += d.slice(0, MAX_STDOUT - stdout.length)
    })
    child.stderr.on("data", (d: string) => {
      if (opts.onOutput) opts.onOutput(stripAnsi(d))
      if (stderr.length < MAX_STDERR) stderr += d.slice(0, MAX_STDERR - stderr.length)
    })

    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
    let killTimer: NodeJS.Timeout | undefined
    const stop = () => {
      if (killTimer) return
      kill("SIGTERM")
      killTimer = setTimeout(() => kill("SIGKILL"), 10_000)
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, Math.max(1, opts.timeoutMs))
    const onAbort = () => stop()
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      opts.signal?.removeEventListener("abort", onAbort)
      resolve({ code, stdout, stderr, timedOut })
    }
    child.on("error", (err: NodeJS.ErrnoException) => {
      stderr += err.code === "ENOENT" ? HELM_MISSING : `Failed to run helm: ${err.message}`
      finish(127)
    })
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : null)))
  })
}

/**
 * Runs helm in a workspace. With `onOutput`, the combined output is
 * streamed (redacted, line by line); otherwise stdout is captured and
 * returned redacted of exact secrets only (it is parsed, e.g. JSON).
 */
export async function runHelm(
  ws: HelmWorkspace,
  args: string[],
  opts: { timeoutMs: number; onOutput?: (text: string) => void; signal?: AbortSignal }
): Promise<HelmRun> {
  const redactor = opts.onOutput ? lineRedactor(ws.secrets, (t) => opts.onOutput!(t.split(ws.dir).join("<tmp>"))) : null
  const res = await spawnHelm(args, {
    env: ws.env,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onOutput: redactor ? (t) => redactor.push(t) : undefined,
  })
  redactor?.flush()
  return { ...res, stdout: ws.redact(res.stdout, true), stderr: ws.redact(res.stderr) }
}

/** The useful part of helm's stderr for an error message ("Error: ..." lines). */
export function helmErrorMessage(run: HelmRun, what: string): string {
  if (run.timedOut) return `${what} timed out and was stopped`
  const lines = run.stderr.split("\n").map((l) => l.trim()).filter(Boolean)
  const error = lines.filter((l) => l.startsWith("Error:")).pop() ?? lines.pop() ?? `exit code ${run.code}`
  const message = error.replace(/^Error:\s*/, "")
  return `${what} failed: ${message.length > 600 ? `${message.slice(0, 600)}…` : message}`
}

// ----------------------------------------------------------------- limits

/**
 * Reserves a release for one mutating command. Returns the release
 * function, or throws when another Gantry operation on it is running or
 * too many operations run already.
 */
export function lockRelease(environmentId: number, namespace: string, name: string): () => void {
  const key = `${environmentId}:${namespace}/${name}`
  if (state.locks.has(key)) {
    throw new HelmError(`Another Helm operation on ${namespace}/${name} is still running. Wait for it to finish.`, 409)
  }
  if (state.operations >= maxOperations()) {
    throw new HelmError(`${state.operations} Helm operations are running already; try again when one has finished.`, 429)
  }
  state.locks.add(key)
  state.operations++
  let released = false
  return () => {
    if (released) return
    released = true
    state.locks.delete(key)
    state.operations--
  }
}

/** Bounds concurrent read-only commands (search, show values). */
export async function withQuerySlot<T>(fn: () => Promise<T>): Promise<T> {
  if (state.queries >= MAX_QUERIES) throw new HelmError("The server is busy with other Helm queries; try again in a moment.", 429)
  state.queries++
  try {
    return await fn()
  } finally {
    state.queries--
  }
}
