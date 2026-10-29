import { isMap, parseDocument } from "yaml"
import { z } from "zod"

// Pure stack helpers (validation, dotenv parsing) shared by Server Actions,
// pages and unit tests. Nothing here touches the filesystem or Docker.

/** Compose project names: lowercase, digits, dash and underscore (what `docker compose -p` accepts). */
export const STACK_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/

export const MAX_COMPOSE_BYTES = 512 * 1024
export const MAX_ENV_BYTES = 64 * 1024

export const stackNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .regex(STACK_NAME_RE, "Lowercase letters, digits, dash or underscore; must start with a letter or digit (max 63)")

/** Textareas submit CRLF; files on disk get LF and a trailing newline. */
export function normalizeText(text: string) {
  const lf = text.replace(/\r\n?/g, "\n")
  return lf.trim() === "" ? "" : lf.replace(/\n*$/, "\n")
}

export type ComposeCheck = { ok: true; services: string[] } | { ok: false; error: string }

/**
 * Checks that the text is a single YAML document with a top-level `services`
 * mapping of service mappings. Full schema validation is left to
 * `docker compose`, whose output is shown when a deploy fails.
 */
export function validateCompose(text: string): ComposeCheck {
  if (!text.trim()) return { ok: false, error: "The compose file is empty" }
  if (byteLength(text) > MAX_COMPOSE_BYTES) {
    return { ok: false, error: `The compose file is larger than ${MAX_COMPOSE_BYTES / 1024} KB` }
  }

  const doc = parseDocument(text, { uniqueKeys: true })
  if (doc.errors.length) return { ok: false, error: `Invalid YAML: ${firstLine(doc.errors[0].message)}` }

  const root = doc.contents
  if (!isMap(root)) return { ok: false, error: "The compose file must be a YAML mapping (key: value)" }

  const services = root.get("services", true)
  if (!isMap(services)) return { ok: false, error: "The compose file needs a `services:` mapping" }
  if (services.items.length === 0) return { ok: false, error: "Define at least one service under `services:`" }

  const names: string[] = []
  for (const item of services.items) {
    const name = String((item.key as { value?: unknown } | null)?.value ?? item.key)
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return { ok: false, error: `Invalid service name "${name}"` }
    }
    if (!isMap(item.value)) {
      return { ok: false, error: `Service "${name}" must be a mapping (e.g. image: alpine:3)` }
    }
    names.push(name)
  }
  return { ok: true, services: names }
}

function byteLength(text: string) {
  return new TextEncoder().encode(text).length
}

function firstLine(message: string) {
  return message.split("\n")[0].replace(/:\s*$/, "")
}

export type DotenvEntry = { key: string; value: string }
export type DotenvResult = { entries: DotenvEntry[]; errors: string[] }

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/

/**
 * Parses dotenv text the way `docker compose` reads `.env`: KEY=value lines,
 * optional `export `, `#` comments, single quotes (literal), double quotes
 * (may span lines, `\n` escapes) and inline ` #` comments after unquoted values.
 */
export function parseDotenv(text: string): DotenvResult {
  const entries: DotenvEntry[] = []
  const errors: string[] = []
  const lines = text.replace(/\r\n?/g, "\n").split("\n")

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const line = lines[i].trim()
    if (!line || line.startsWith("#")) continue

    const m = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(line)
    if (!m) {
      errors.push(`Line ${lineNo}: expected KEY=value`)
      continue
    }
    const [, key, rest] = m
    if (!KEY_RE.test(key)) {
      errors.push(`Line ${lineNo}: invalid variable name "${key}"`)
      continue
    }

    const quote = rest[0]
    if (quote === "'" || quote === '"') {
      let body = rest.slice(1)
      let end = findClosingQuote(body, quote)
      // Double-quoted values may continue on the following lines.
      while (end < 0 && quote === '"' && i + 1 < lines.length) {
        i++
        body += `\n${lines[i]}`
        end = findClosingQuote(body, quote)
      }
      if (end < 0) {
        errors.push(`Line ${lineNo}: unterminated ${quote === '"' ? "double" : "single"} quote`)
        continue
      }
      const trailing = body.slice(end + 1).trim()
      if (trailing && !trailing.startsWith("#")) {
        errors.push(`Line ${lineNo}: unexpected text after the closing quote`)
        continue
      }
      const raw = body.slice(0, end)
      entries.push({ key, value: quote === '"' ? unescapeDouble(raw) : raw })
      continue
    }

    entries.push({ key, value: rest.replace(/\s+#.*$/, "").trim() })
  }
  return { entries, errors }
}

function findClosingQuote(s: string, quote: string) {
  for (let i = 0; i < s.length; i++) {
    if (quote === '"' && s[i] === "\\") {
      i++
      continue
    }
    if (s[i] === quote) return i
  }
  return -1
}

function unescapeDouble(s: string) {
  return s.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c))
}

export function validateDotenv(text: string): string | null {
  if (byteLength(text) > MAX_ENV_BYTES) return `Environment is larger than ${MAX_ENV_BYTES / 1024} KB`
  const { errors } = parseDotenv(text)
  return errors.length ? errors.slice(0, 3).join("; ") : null
}

/** "unknown" when Docker could not be reached. */
export type StackStatus = "running" | "partial" | "stopped" | "down" | "unknown"

/** Summarises a project's containers: all running, some, none, or no containers at all. */
export function stackStatus(running: number, total: number): StackStatus {
  if (total === 0) return "down"
  if (running === total) return "running"
  return running === 0 ? "stopped" : "partial"
}
