import { z } from "zod"
import { isMap, parseDocument } from "yaml"

// Validation for Helm chart repositories, chart references and release
// options. Everything here ends up as an argument of the helm CLI, so the
// rules are strict: no leading "-", no whitespace, no shell or URL tricks.
// Shared by Server Actions and forms; no Node APIs.

/** Repository names: what `helm repo add <name>` accepts, restricted to DNS-label characters. */
export const repoNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(63, "At most 63 characters")
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "Lowercase letters, digits and '-', starting and ending with a letter or digit")

/** Release names: Helm allows a DNS-1123 subdomain of at most 53 characters. */
export const releaseNameSchema = z
  .string()
  .trim()
  .min(1, "Release name is required")
  .max(53, "At most 53 characters")
  .regex(
    /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/,
    "Lowercase letters, digits, '-' and '.', starting and ending with a letter or digit"
  )

/** A chart's name inside a repository (no slashes). */
export const chartNameSchema = z
  .string()
  .trim()
  .min(1, "Chart is required")
  .max(250, "The chart name is too long")
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid chart name")

/** A chart version (SemVer or a constraint helm understands); empty = latest. */
export const chartVersionSchema = z
  .string()
  .trim()
  .max(128, "The version is too long")
  .regex(/^$|^[0-9A-Za-z^~=<>.*+_-][0-9A-Za-z^~=<>.*+_ ,|-]*$/, "Invalid version")
  .refine((v) => !v.startsWith("-"), "Invalid version")

/** Minutes helm waits for resources (--timeout). */
export const MAX_TIMEOUT_MINUTES = 30
export const timeoutSchema = z.coerce
  .number()
  .int("Whole minutes")
  .min(1, "At least 1 minute")
  .max(MAX_TIMEOUT_MINUTES, `At most ${MAX_TIMEOUT_MINUTES} minutes`)

export const MAX_VALUES_BYTES = 512 * 1024

const MAX_URL = 2048
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])

export type Check<T> = { ok: true; value: T } | { ok: false; error: string }

export type RepoUrl = { url: string; oci: boolean }

/**
 * A chart repository address: an https:// (or plain http://) index
 * repository, or an oci:// registry path. Credentials go in their own
 * fields, never in the URL, and are refused over plain http except to
 * loopback (they would cross the network unencrypted).
 */
export function validateRepoUrl(input: string, opts: { withCredentials?: boolean } = {}): Check<RepoUrl> {
  const raw = input.trim()
  if (!raw) return { ok: false, error: "URL is required" }
  if (raw.length > MAX_URL) return { ok: false, error: "The URL is too long" }
  if (/[\s\0]/.test(raw) || raw.startsWith("-")) return { ok: false, error: "Invalid URL" }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: "Use https://… for a chart repository or oci://… for a registry" }
  }
  if (!["https:", "http:", "oci:"].includes(url.protocol)) {
    return { ok: false, error: "Only https://, http:// and oci:// addresses are supported" }
  }
  if (!url.hostname) return { ok: false, error: "The URL needs a host" }
  if (url.username || url.password) return { ok: false, error: "Don't put credentials in the URL; use the username and password fields" }
  if (url.search || url.hash || raw.includes("?") || raw.includes("#")) {
    return { ok: false, error: "The URL must not contain a query string or fragment" }
  }
  if (url.protocol === "http:" && opts.withCredentials && !LOOPBACK.has(url.hostname)) {
    return { ok: false, error: "Credentials need https:// (plain http would send them unencrypted)" }
  }
  if (url.protocol === "oci:") {
    // new URL() keeps oci:// as an opaque-ish URL; rebuild it from its parts.
    const path = url.pathname.replace(/\/+$/, "")
    if (!/^[A-Za-z0-9._~/-]*$/.test(path)) return { ok: false, error: "Invalid registry path" }
    return { ok: true, value: { url: `oci://${url.host}${path}`, oci: true } }
  }
  return { ok: true, value: { url: url.toString().replace(/\/+$/, ""), oci: false } }
}

/**
 * A full OCI chart reference (oci://host[:port]/path/chart) typed on the
 * install page. Tags go in the version field.
 */
export function validateOciRef(input: string): Check<string> {
  const raw = input.trim()
  if (!raw.startsWith("oci://")) return { ok: false, error: "OCI references start with oci://" }
  const res = validateRepoUrl(raw)
  if (!res.ok) return res
  const path = res.value.url.slice("oci://".length).split("/").slice(1)
  if (!path.length || !path[path.length - 1]) return { ok: false, error: "Add the chart's path, e.g. oci://registry.example.com/charts/app" }
  const chart = chartNameSchema.safeParse(path[path.length - 1])
  if (!chart.success) return { ok: false, error: "Invalid chart name at the end of the reference" }
  return { ok: true, value: res.value.url }
}

/** Username/password checks: they end up in helm's YAML/JSON config files. */
export function checkRepoCredentials(username: string, password: string): string | null {
  if (!username && !password) return null
  if (!username) return "Enter the username that goes with the password"
  if (!password) return "Enter the password or token"
  if (username.length > 255 || !/^[^\s:\0]+$/.test(username)) return "The username can't contain spaces or ':'"
  if (password.length > 4096 || /[\r\n\0]/.test(password)) return "The password can't contain line breaks"
  return null
}

/**
 * Values YAML from the editor: empty, or a single mapping. Returns the text
 * unchanged (helm parses it again) so comments and formatting survive.
 */
export function checkValuesYaml(text: string): Check<string> {
  if (new TextEncoder().encode(text).length > MAX_VALUES_BYTES) return { ok: false, error: "The values are too large" }
  if (!text.trim()) return { ok: true, value: "" }
  const doc = parseDocument(text, { uniqueKeys: true })
  if (doc.errors.length) {
    const e = doc.errors[0]
    const line = e.linePos?.[0]?.line
    return { ok: false, error: `Invalid YAML${line ? ` (line ${line})` : ""}: ${e.message.split("\n")[0]}` }
  }
  if (doc.contents === null) return { ok: true, value: "" }
  if (!isMap(doc.contents)) return { ok: false, error: "Values must be a YAML mapping (key: value)" }
  try {
    doc.toJS({ maxAliasCount: 100 })
  } catch (err) {
    return { ok: false, error: `Invalid YAML: ${(err as Error).message}` }
  }
  return { ok: true, value: text }
}

/** One chart (latest version) of a repository, or one version of a chart. */
export type ChartVersion = { name: string; version: string; appVersion: string; description: string }

/** Where an install or upgrade takes its chart from. */
export type ChartSource = { type: "repo"; repoId: number; chart: string } | { type: "oci"; ref: string }
