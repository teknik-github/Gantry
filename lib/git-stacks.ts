import { z } from "zod"

// Pure helpers for stacks sourced from a Git repository: validation of the
// repository URL, ref and compose file path, push-ref matching for webhooks.
// Shared by Server Actions, the webhook route, pages and unit tests; nothing
// here runs git or touches the filesystem.

export const DEFAULT_GIT_REF = "main"
export const DEFAULT_COMPOSE_PATH = "docker-compose.yml"
/** Polling interval bounds (minutes); 0 = off. */
export const MAX_POLL_MINUTES = 24 * 60

const MAX_URL = 2048
const MAX_REF = 255
const MAX_PATH = 1024

/**
 * Test-only escape hatch: with GANTRY_TEST_ALLOW_HTTP_GIT=1 plain http:// is
 * accepted, but only for loopback hosts (the E2E suite serves a repository
 * from the test process). Never set this in production.
 */
export function allowHttpLoopback(env: NodeJS.ProcessEnv = process.env) {
  return env.GANTRY_TEST_ALLOW_HTTP_GIT === "1"
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])

export type Check<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Repository URLs: https only (http only for loopback when the test flag is
 * set), no embedded credentials (use the credential fields), no query or
 * fragment. The normalized form is what gets stored and passed to git.
 */
export function validateRepoUrl(input: string, opts: { allowHttpLoopback?: boolean } = {}): Check<string> {
  const raw = input.trim()
  if (!raw) return { ok: false, error: "Repository URL is required" }
  if (raw.length > MAX_URL) return { ok: false, error: "The URL is too long" }
  // git treats some strings as options or transports (ext::, fd::, file paths).
  if (/[\s\0]/.test(raw) || raw.startsWith("-")) return { ok: false, error: "Invalid repository URL" }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: "Use an https:// URL, e.g. https://github.com/owner/repo.git" }
  }
  const httpOk = url.protocol === "http:" && opts.allowHttpLoopback === true && LOOPBACK.has(url.hostname)
  if (url.protocol !== "https:" && !httpOk) {
    return { ok: false, error: "Only https:// repository URLs are supported" }
  }
  if (!url.hostname) return { ok: false, error: "The URL needs a host" }
  if (url.username || url.password) {
    return { ok: false, error: "Don't put credentials in the URL; use the username and token fields" }
  }
  if (url.search || url.hash || raw.includes("?") || raw.includes("#")) {
    return { ok: false, error: "The URL must not contain a query string or fragment" }
  }
  if (url.pathname === "/" || url.pathname === "") return { ok: false, error: "The URL needs a repository path" }
  return { ok: true, value: url.toString() }
}

/** A full commit id (SHA-1 or SHA-256). */
export function isCommitSha(ref: string) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)
}

/**
 * Branch, tag (`v1.2`, `refs/tags/v1.2`, `refs/heads/main`) or a full commit
 * id. Follows git's ref-name rules closely enough that a valid value can't be
 * read as an option or a refspec with a destination.
 */
export function validateRef(input: string): Check<string> {
  const ref = input.trim()
  if (!ref) return { ok: false, error: "Branch, tag or commit is required" }
  if (ref.length > MAX_REF) return { ok: false, error: "The ref is too long" }
  if (isCommitSha(ref.toLowerCase())) return { ok: true, value: ref.toLowerCase() }
  const invalid =
    !/^[A-Za-z0-9._/+-]+$/.test(ref) ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.split("/").some((part) => part.startsWith(".")) ||
    ref === "HEAD" ||
    ref === "FETCH_HEAD"
  if (invalid) return { ok: false, error: "Not a valid branch or tag name" }
  return { ok: true, value: ref }
}

/**
 * Compose file path inside the repository: relative, forward slashes, no
 * `.`/`..` segments, nothing inside .git, ending in .yml/.yaml. Symlinks are
 * checked against the checkout when the file is read.
 */
export function validateComposePath(input: string): Check<string> {
  let p = input.trim().replace(/^(?:\.\/)+/, "")
  if (!p) p = DEFAULT_COMPOSE_PATH
  if (p.length > MAX_PATH) return { ok: false, error: "The path is too long" }
  if (p.startsWith("/") || p.includes("\\")) return { ok: false, error: "Use a path relative to the repository root" }
  if (!/^[A-Za-z0-9._@+/-]+$/.test(p) || p.startsWith("-")) {
    return { ok: false, error: "Letters, digits, . _ - @ + and / only" }
  }
  const parts = p.split("/")
  if (parts.some((s) => s === "" || s === "." || s === "..")) {
    return { ok: false, error: "The path must stay inside the repository (no . or .. segments)" }
  }
  if (parts[0] === ".git") return { ok: false, error: "The path must not point into .git" }
  if (!/\.ya?ml$/i.test(p)) return { ok: false, error: "The compose file must end in .yml or .yaml" }
  return { ok: true, value: p }
}

export const pollMinutesSchema = z.coerce
  .number()
  .int("Whole minutes")
  .min(0, "0 (off) or more")
  .max(MAX_POLL_MINUTES, `At most ${MAX_POLL_MINUTES} minutes`)

/**
 * Whether a pushed ref (`refs/heads/main`, `refs/tags/v1`) is the one a
 * stack follows. Stacks pinned to a commit never match.
 */
export function refMatches(stackRef: string, pushedRef: string | null | undefined): boolean {
  if (!pushedRef || isCommitSha(stackRef)) return false
  if (stackRef.startsWith("refs/")) return pushedRef === stackRef
  return pushedRef === `refs/heads/${stackRef}` || pushedRef === `refs/tags/${stackRef}`
}

export function shortSha(sha: string | null | undefined) {
  return sha ? sha.slice(0, 7) : ""
}

/** Webhook path for an opaque hook id. */
export function webhookPath(hookId: string) {
  return `/api/webhooks/stacks/${hookId}`
}

/** Opaque webhook ids are 32 base64url characters (24 random bytes). */
export const WEBHOOK_ID_RE = /^[A-Za-z0-9_-]{32}$/
