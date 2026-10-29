// Pure parsing/formatting helpers for the container create and edit forms.
// Shared by Server Actions and unit tests ("use server" files may only
// export async functions, so these live here).

import { z } from "zod"

export const imageField = z.string().trim().min(1, "Image is required").max(255)
export const containerNameField = z
  .string()
  .trim()
  .max(128)
  .regex(/^([a-zA-Z0-9][a-zA-Z0-9_.-]*)?$/, "Letters, numbers, dot, dash or underscore")

export type PortBinding = { HostIp: string; HostPort: string }
export type PortBindings = Record<string, PortBinding[] | null>

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string; fieldError: string }

/** Non-empty, non-comment lines of a textarea. Handles CRLF from form posts. */
export function lines(value: string) {
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
}

/** "a b 'c d'" -> ["a", "b", "c d"] */
export function splitArgs(value: string) {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, "$2"))
}

/** Inverse of splitArgs where possible: quotes arguments containing whitespace. */
export function formatArgs(args: string[] | null | undefined) {
  return (args ?? [])
    .map((a) => {
      if (a !== "" && !/[\s"']/.test(a)) return a
      return a.includes('"') ? `'${a}'` : `"${a}"`
    })
    .join(" ")
}

// [ip:]hostPort:containerPort[/proto], [ip::]containerPort[/proto] (random host port).
// IPv6 host addresses are written in brackets: [::1]:8080:80.
const portRe =
  /^(?:(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:.]+\]):)?(?:(\d{1,5}(?:-\d{1,5})?)?:)?(\d{1,5})(?:\/(tcp|udp|sctp))?$/

export function parsePorts(text: string): ParseResult<{ exposed: Record<string, object>; bindings: Record<string, PortBinding[]> }> {
  const exposed: Record<string, object> = {}
  const bindings: Record<string, PortBinding[]> = {}
  for (const spec of lines(text)) {
    const m = portRe.exec(spec)
    const hostPorts = m?.[2]?.split("-").map(Number) ?? []
    if (!m || Number(m[3]) > 65535 || hostPorts.some((p) => p < 1 || p > 65535) || Number(m[3]) < 1) {
      return {
        ok: false,
        error: "Invalid port mapping",
        fieldError: `"${spec}" — use host:container, e.g. 8080:80`,
      }
    }
    const key = `${m[3]}/${m[4] ?? "tcp"}`
    exposed[key] = {}
    ;(bindings[key] ??= []).push({ HostIp: (m[1] ?? "").replace(/^\[(.*)\]$/, "$1"), HostPort: m[2] ?? "" })
  }
  return { ok: true, value: { exposed, bindings } }
}

/** One line per binding, in the syntax parsePorts accepts. */
export function formatPorts(bindings: PortBindings | null | undefined) {
  const out: string[] = []
  const keys = Object.keys(bindings ?? {}).sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b))
  for (const key of keys) {
    const [port, proto = "tcp"] = key.split("/")
    for (const b of bindings?.[key] ?? []) {
      const ip = b.HostIp ? (b.HostIp.includes(":") ? `[${b.HostIp}]` : b.HostIp) : ""
      const host = ip ? `${ip}:${b.HostPort}:` : b.HostPort ? `${b.HostPort}:` : ""
      out.push(`${host}${port}${proto === "tcp" ? "" : `/${proto}`}`)
    }
  }
  return out.join("\n")
}

export function parseEnv(text: string): ParseResult<string[]> {
  const env = lines(text)
  for (const e of env) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*=/.test(e)) {
      return { ok: false, error: "Invalid environment variable", fieldError: `"${e}" — use KEY=value` }
    }
  }
  return { ok: true, value: env }
}

const MOUNT_OPTIONS = new Set(["ro", "rw", "z", "Z", "nocopy", "shared", "rshared", "slave", "rslave", "private", "rprivate"])

/** "source:/container/path[:options]" where source is a volume name or an absolute host path. */
export function parseVolumes(text: string): ParseResult<string[]> {
  const binds = lines(text)
  const targets = new Set<string>()
  for (const b of binds) {
    const m = /^([^:]+):(\/[^:]*)(?::([^:]+))?$/.exec(b)
    const opts = m?.[3]?.split(",") ?? []
    if (!m || opts.some((o) => !MOUNT_OPTIONS.has(o))) {
      return {
        ok: false,
        error: "Invalid volume",
        fieldError: `"${b}" — use volume-or-path:/container/path[:ro]`,
      }
    }
    const target = m[2].replace(/(.)\/+$/, "$1")
    if (targets.has(target)) {
      return { ok: false, error: "Invalid volume", fieldError: `"${target}" is mounted more than once` }
    }
    targets.add(target)
  }
  return { ok: true, value: binds }
}

export const RESTART_POLICIES = ["no", "always", "unless-stopped", "on-failure"] as const
export type RestartPolicyName = (typeof RESTART_POLICIES)[number]

export function restartName(name: string | undefined): RestartPolicyName {
  return (RESTART_POLICIES as readonly string[]).includes(name ?? "") ? (name as RestartPolicyName) : "no"
}

/** Same lines in the same order (ignores blank lines, comments, surrounding whitespace, CRLF). */
export function sameLines(a: string, b: string) {
  const x = lines(a)
  const y = lines(b)
  return x.length === y.length && x.every((l, i) => l === y[i])
}

/** The editable subset of a container, as the edit form shows it. */
export type EditFormValues = {
  image: string
  name: string
  command: string
  env: string
  ports: string
  volumes: string
  restart: RestartPolicyName
  /** Attached networks; empty when the network mode isn't editable (host, none, container:…). */
  networks: string[]
}
