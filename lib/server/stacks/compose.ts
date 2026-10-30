import "server-only"

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { config } from "@/lib/server/config"
import type { DockerTarget } from "@/lib/server/docker/client"
import { dockerConfigJson, type RegistryCredentials } from "@/lib/registry"
import { STACK_NAME_RE } from "@/lib/stacks"

// Runs the `docker compose` CLI against a Gantry environment. Always spawned
// with an argument array (never a shell) and a minimal environment.

export const COMPOSE_FILE = "docker-compose.yml"
export const ENV_FILE = ".env"

/** Keep the tail of the output; DB column and UI don't need more. */
export const MAX_OUTPUT_CHARS = 200_000

export const STACK_OPERATIONS = ["deploy", "redeploy", "start", "stop", "restart", "down"] as const
export type StackOperation = (typeof STACK_OPERATIONS)[number]

/** `docker compose` subcommands per operation; run in order, stopping at the first failure. */
export function operationCommands(op: StackOperation, opts: { removeVolumes?: boolean } = {}): string[][] {
  switch (op) {
    case "deploy":
      return [["up", "-d", "--remove-orphans"]]
    case "redeploy":
      return [["pull"], ["up", "-d", "--remove-orphans"]]
    case "start":
      return [["start"]]
    case "stop":
      return [["stop"]]
    case "restart":
      return [["restart"]]
    case "down":
      return [["down", "--remove-orphans", ...(opts.removeVolumes ? ["-v"] : [])]]
  }
}

/** Full argv for `docker` (project name and files are always explicit). */
export function composeArgs(project: string, command: string[]): string[] {
  if (!STACK_NAME_RE.test(project)) throw new Error(`Invalid project name: ${project}`)
  return [
    "compose",
    "--ansi",
    "never",
    "--progress",
    "plain",
    "-p",
    project,
    "-f",
    COMPOSE_FILE,
    "--env-file",
    ENV_FILE,
    ...command,
  ]
}

/** DOCKER_HOST value for an environment. */
export function dockerHost(target: DockerTarget): string {
  if (target.type === "socket") return `unix://${target.url}`
  // tcp environments are stored as host:port, optionally with tcp:// or http://.
  return `tcp://${target.url.replace(/^[a-z]+:\/\//i, "")}`
}

/**
 * Environment for the CLI. Deliberately not process.env: compose interpolates
 * ${VARS} from its own environment first, which would expose Gantry's secrets
 * (GANTRY_SECRET, database credentials) to compose files.
 */
export function composeEnv(
  target: DockerTarget,
  certDir: string | null,
  base: NodeJS.ProcessEnv = process.env,
  /** Private config dir with Gantry's registry logins; replaces DOCKER_CONFIG. */
  configDir: string | null = null
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: base.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: base.HOME || os.tmpdir(),
    // Takes precedence over any context in a mounted CLI config.
    DOCKER_HOST: dockerHost(target),
  }
  // Registry credentials (config.json) for private images.
  if (configDir) env.DOCKER_CONFIG = configDir
  else if (base.DOCKER_CONFIG) env.DOCKER_CONFIG = base.DOCKER_CONFIG
  for (const k of ["TZ", "LANG", "LC_ALL"]) if (base[k]) env[k] = base[k]!
  if (certDir) {
    env.DOCKER_TLS_VERIFY = "1"
    env.DOCKER_CERT_PATH = certDir
  }
  return env
}

export function stacksRoot() {
  return path.join(config.dataDir, "stacks")
}

/** Per-stack working directory: compose resolves relative paths from here. */
export function stackDir(environmentId: number, name: string) {
  if (!Number.isInteger(environmentId) || environmentId <= 0 || !STACK_NAME_RE.test(name)) {
    throw new Error("Invalid stack directory")
  }
  return path.join(stacksRoot(), `${environmentId}-${name}`)
}

export async function writeStackFiles(dir: string, compose: string, env: string) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(/* turbopackIgnore: true */ dir, COMPOSE_FILE), compose, { mode: 0o600 })
  // .env may hold secrets.
  await fs.writeFile(path.join(/* turbopackIgnore: true */ dir, ENV_FILE), env, { mode: 0o600 })
}

export async function removeStackDir(dir: string) {
  // Never follow a crafted path outside the stacks root.
  const root = stacksRoot()
  if (path.dirname(dir) !== root) throw new Error("Refusing to remove a directory outside the stacks root")
  await fs.rm(dir, { recursive: true, force: true })
}

/** Collects combined stdout/stderr, keeping only the last `max` characters. */
export class OutputBuffer {
  private chunks: string[] = []
  private length = 0
  private dropped = 0

  constructor(private max = MAX_OUTPUT_CHARS) {}

  append(text: string) {
    const clean = stripAnsi(text)
    if (!clean) return
    this.chunks.push(clean)
    this.length += clean.length
    while (this.length > this.max && this.chunks.length > 0) {
      const over = this.length - this.max
      const first = this.chunks[0]
      if (first.length <= over) {
        this.chunks.shift()
        this.length -= first.length
        this.dropped += first.length
      } else {
        this.chunks[0] = first.slice(over)
        this.length -= over
        this.dropped += over
      }
    }
  }

  toString() {
    const body = this.chunks.join("")
    return this.dropped ? `[… ${this.dropped} earlier characters truncated …]\n${body}` : body
  }
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g

export function stripAnsi(text: string) {
  return text.replace(ANSI_RE, "")
}

export type ComposeRun = { code: number | null; output: string; timedOut: boolean }

/**
 * Runs `docker compose <command>` for each command in turn inside `cwd`.
 * TLS material (if any) is written to a private temp dir for the duration of
 * the run. Stops at the first non-zero exit.
 */
export async function runCompose(opts: {
  target: DockerTarget
  project: string
  cwd: string
  commands: string[][]
  timeoutMs: number
  /** Registry logins for pulls (written to a private config.json for the run). */
  registries?: RegistryCredentials[]
}): Promise<ComposeRun> {
  const out = new OutputBuffer()
  const certDir = opts.target.tls ? await writeCerts(opts.target.tls) : null
  let configDir: string | null = null
  const deadline = Date.now() + opts.timeoutMs

  try {
    if (opts.registries?.length) configDir = await writeDockerConfig(opts.registries)
    const env = composeEnv(opts.target, certDir, process.env, configDir)
    for (const command of opts.commands) {
      out.append(`$ docker compose ${command.join(" ")}\n`)
      const res = await spawnCompose(composeArgs(opts.project, command), opts.cwd, env, deadline - Date.now(), out)
      if (res.timedOut) {
        out.append(`\nTimed out after ${Math.round(opts.timeoutMs / 1000)} s; the command was stopped.\n`)
        return { code: res.code, output: out.toString(), timedOut: true }
      }
      if (res.code !== 0) {
        out.append(`\nExited with code ${res.code ?? "unknown"}.\n`)
        return { code: res.code, output: out.toString(), timedOut: false }
      }
    }
    return { code: 0, output: out.toString(), timedOut: false }
  } finally {
    if (certDir) await fs.rm(certDir, { recursive: true, force: true }).catch(() => {})
    if (configDir) await fs.rm(configDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * A private DOCKER_CONFIG dir for one compose run: Gantry's registry logins
 * on top of the `auths` of a mounted DOCKER_CONFIG (Gantry's win), plus a
 * link to its cli-plugins. The caller removes the dir.
 */
export async function writeDockerConfig(creds: RegistryCredentials[], base: NodeJS.ProcessEnv = process.env) {
  const merged = JSON.parse(dockerConfigJson(creds)) as { auths: Record<string, unknown> }
  if (base.DOCKER_CONFIG) {
    try {
      const existing = JSON.parse(
        await fs.readFile(path.join(/* turbopackIgnore: true */ base.DOCKER_CONFIG, "config.json"), "utf8")
      ) as { auths?: Record<string, unknown> }
      merged.auths = { ...existing.auths, ...merged.auths }
    } catch {
      // No readable config.json there; Gantry's logins only.
    }
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gantry-docker-config-"))
  try {
    await fs.writeFile(path.join(dir, "config.json"), `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 })
    // The CLI also looks for plugins (compose) in $DOCKER_CONFIG/cli-plugins.
    if (base.DOCKER_CONFIG) {
      const plugins = path.join(/* turbopackIgnore: true */ base.DOCKER_CONFIG, "cli-plugins")
      if (await fs.stat(plugins).then((st) => st.isDirectory(), () => false)) await fs.symlink(plugins, path.join(dir, "cli-plugins"))
    }
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  return dir
}

function spawnCompose(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  out: OutputBuffer
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let timedOut = false
    let settled = false
    // turbopackIgnore: these are runtime paths, not files to trace into the
    // standalone build (otherwise the whole project gets copied into it).
    const child = spawn(/* turbopackIgnore: true */ process.env.DOCKER_CLI || "docker", args, {
      cwd: /* turbopackIgnore: true */ cwd,
      // Replaces (not extends) the parent environment; see composeEnv().
      env: env as unknown as NodeJS.ProcessEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d: string) => out.append(d))
    child.stderr.on("data", (d: string) => out.append(d))

    let killTimer: NodeJS.Timeout | undefined
    const timer = setTimeout(
      () => {
        timedOut = true
        child.kill("SIGTERM")
        // Compose cancels cleanly on SIGTERM; force it if it doesn't.
        killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000)
      },
      Math.max(1, timeoutMs)
    )

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({ code, timedOut })
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      out.append(
        err.code === "ENOENT"
          ? "The docker CLI was not found. Install docker-cli and docker-cli-compose (the Gantry image includes them).\n"
          : `Failed to run docker compose: ${err.message}\n`
      )
      finish(127)
    })
    child.on("close", (code, signal) => finish(code ?? (signal ? 128 : null)))
  })
}

/** Writes ca.pem/cert.pem/key.pem for DOCKER_CERT_PATH; the caller removes the dir. */
export async function writeCerts(tls: { ca: string; cert: string; key: string }) {
  // mkdtemp creates the directory with mode 0700.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gantry-tls-"))
  try {
    await fs.writeFile(path.join(dir, "ca.pem"), tls.ca, { mode: 0o600 })
    await fs.writeFile(path.join(dir, "cert.pem"), tls.cert, { mode: 0o600 })
    await fs.writeFile(path.join(dir, "key.pem"), tls.key, { mode: 0o600 })
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
  return dir
}
