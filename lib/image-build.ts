import { validateRef, validateRepoUrl, type Check } from "@/lib/git-stacks"

// Pure helpers for building, tagging and pushing images: validation of the
// build options and sources, image references, the JSON-lines stream Docker
// sends for /build and /images/{name}/push, and the events Gantry streams to
// the browser. Shared by route handlers, Server Actions, the UI and unit
// tests; nothing here touches Docker, git or the filesystem.

/** At most this many tags per build. */
export const MAX_TAGS = 10
export const MAX_BUILD_ARGS = 50
export const MAX_LABELS = 50
const MAX_KV_VALUE = 4096
/** Dockerfile written in the editor. */
export const MAX_DOCKERFILE_BYTES = 256 * 1024
/** Extra files next to an editor Dockerfile. */
export const MAX_EXTRA_FILES = 20
/** Dockerfile and extra files together. */
export const MAX_EDITOR_CONTEXT_BYTES = 1024 * 1024
/** JSON body of a build request (editor files included). */
export const MAX_BUILD_REQUEST_BYTES = 2 * 1024 * 1024
/** Header carrying the build options (URI-encoded JSON) next to an uploaded archive. */
export const BUILD_OPTIONS_HEADER = "x-gantry-build-options"
/** Encoded build options sent in a header with an uploaded archive. */
export const MAX_OPTIONS_HEADER = 12 * 1024
const MAX_PATH = 1024

export const DEFAULT_DOCKERFILE = "Dockerfile"
export const EXAMPLE_DOCKERFILE = `FROM alpine:3
ARG GREETING=hello
RUN echo "$GREETING from Gantry" > /greeting.txt
CMD ["cat", "/greeting.txt"]
`

export type BuildStatus = "running" | "success" | "error" | "cancelled"

// ---------------------------------------------------------------------------
// Image references

/** Docker's reference grammar (distribution/reference), without digests. */
const DOMAIN_COMPONENT = "(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])"
const DOMAIN = `(?:${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*|\\[[0-9a-fA-F:]+\\])(?::[0-9]+)?`
const PATH_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*"
const DOMAIN_RE = new RegExp(`^${DOMAIN}$`)
const PATH_COMPONENT_RE = new RegExp(`^${PATH_COMPONENT}$`)
const TAG_RE = /^[\w][\w.-]{0,127}$/

export type ImageReference = {
  /** Repository with its registry, e.g. "localhost:5000/team/app". */
  repository: string
  tag: string
  /** "repository:tag" */
  reference: string
}

/**
 * Parses "name[:tag]" the way Docker does (a first component containing "."
 * or ":" or equal to "localhost" is a registry). The tag defaults to
 * "latest". Repository paths must be lowercase. Digests aren't tags.
 */
export function parseImageReference(input: string): Check<ImageReference> {
  const ref = input.trim()
  if (!ref) return { ok: false, error: "Enter an image name, e.g. registry.example.com/team/app:1.0" }
  if (ref.length > 255) return { ok: false, error: "The image name is too long (255 characters at most)" }
  if (ref.includes("@")) return { ok: false, error: "Use a tag, not a digest" }
  const lastSlash = ref.lastIndexOf("/")
  const lastColon = ref.lastIndexOf(":")
  const hasTag = lastColon > lastSlash
  const name = hasTag ? ref.slice(0, lastColon) : ref
  const tag = hasTag ? ref.slice(lastColon + 1) : "latest"
  if (!TAG_RE.test(tag)) return { ok: false, error: `"${tag}" is not a valid tag (letters, digits, _ . -; 128 at most)` }

  const parts = name.split("/")
  const first = parts[0]
  const hasDomain = parts.length > 1 && (first === "localhost" || first.includes(".") || first.includes(":"))
  if (hasDomain && !DOMAIN_RE.test(first)) return { ok: false, error: `"${first}" is not a valid registry address` }
  const path = hasDomain ? parts.slice(1) : parts
  if (!path.length || path.some((p) => !p)) return { ok: false, error: "The image name has an empty path component" }
  for (const p of path) {
    if (!PATH_COMPONENT_RE.test(p)) {
      return {
        ok: false,
        error: /[A-Z]/.test(p)
          ? "Repository names must be lowercase"
          : `"${p}" is not valid in an image name (lowercase letters, digits and . _ - separators)`,
      }
    }
  }
  return { ok: true, value: { repository: name, tag, reference: `${name}:${tag}` } }
}

/** Tags typed one per line (or separated by commas/spaces), normalized and deduplicated. */
export function parseTags(text: string): Check<string[]> {
  const items = text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (!items.length) return { ok: false, error: "Add at least one tag, e.g. my-app:1.0" }
  const out: string[] = []
  for (const item of items) {
    const parsed = parseImageReference(item)
    if (!parsed.ok) return { ok: false, error: `${item}: ${parsed.error}` }
    if (!out.includes(parsed.value.reference)) out.push(parsed.value.reference)
  }
  if (out.length > MAX_TAGS) return { ok: false, error: `At most ${MAX_TAGS} tags` }
  return { ok: true, value: out }
}

// ---------------------------------------------------------------------------
// Options

/**
 * KEY=value per line; blank lines and # comments are skipped. Keys are
 * checked with `keyRe`, duplicates keep the last value.
 */
export function parseKeyValueLines(
  text: string,
  opts: { what: string; keyRe: RegExp; keyHint: string; max: number }
): Check<Record<string, string>> {
  const out: Record<string, string> = {}
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    const key = (eq < 0 ? line : line.slice(0, eq)).trim()
    const value = eq < 0 ? "" : line.slice(eq + 1)
    if (eq < 0) return { ok: false, error: `Line ${i + 1}: use KEY=value` }
    if (!opts.keyRe.test(key)) return { ok: false, error: `Line ${i + 1}: ${opts.keyHint}` }
    if (value.length > MAX_KV_VALUE) return { ok: false, error: `Line ${i + 1}: the value is too long` }
    out[key] = value
  }
  if (Object.keys(out).length > opts.max) return { ok: false, error: `At most ${opts.max} ${opts.what}` }
  return { ok: true, value: out }
}

export const parseBuildArgs = (text: string) =>
  parseKeyValueLines(text, {
    what: "build arguments",
    keyRe: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/,
    keyHint: "build argument names are letters, digits and _ (not starting with a digit)",
    max: MAX_BUILD_ARGS,
  })

export const parseLabels = (text: string) =>
  parseKeyValueLines(text, {
    what: "labels",
    keyRe: /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/,
    keyHint: "label keys are letters, digits and . _ / -",
    max: MAX_LABELS,
  })

/** Multi-stage target; empty = the last stage. */
export function validateTarget(input: string): Check<string> {
  const t = input.trim()
  if (!t) return { ok: true, value: "" }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(t)) return { ok: false, error: "Stage names are letters, digits and . _ -" }
  return { ok: true, value: t }
}

/**
 * A relative path inside a build context or repository: forward slashes, no
 * `.`/`..` segments, nothing inside .git. `fallback` replaces an empty value
 * ("" = allowed to stay empty, meaning the root).
 */
export function validateRelativePath(input: string, fallback: string, what: string): Check<string> {
  let p = input.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, "")
  if (!p || p === ".") p = fallback
  if (!p) return { ok: true, value: "" }
  if (p.length > MAX_PATH) return { ok: false, error: `The ${what} is too long` }
  if (p.startsWith("/") || p.includes("\\")) return { ok: false, error: `Use a ${what} relative to the root` }
  if (!/^[A-Za-z0-9._@+/-]+$/.test(p) || p.startsWith("-")) {
    return { ok: false, error: "Letters, digits, . _ - @ + and / only" }
  }
  const parts = p.split("/")
  if (parts.some((s) => s === "" || s === "." || s === "..")) {
    return { ok: false, error: `The ${what} must stay inside (no . or .. segments)` }
  }
  if (parts.includes(".git")) return { ok: false, error: `The ${what} must not point into .git` }
  return { ok: true, value: p }
}

export const validateDockerfilePath = (input: string) => validateRelativePath(input, DEFAULT_DOCKERFILE, "Dockerfile path")
export const validateContextPath = (input: string) => validateRelativePath(input, "", "context directory")

export type BuildOptions = {
  tags: string[]
  buildArgs: Record<string, string>
  labels: Record<string, string>
  target: string
  noCache: boolean
  pull: boolean
  push: boolean
}

/** What the form sends; text fields are parsed on the server. */
export type RawBuildOptions = {
  tags?: unknown
  buildArgs?: unknown
  labels?: unknown
  target?: unknown
  noCache?: unknown
  pull?: unknown
  push?: unknown
}

export type FieldErrors = Record<string, string[]>

const str = (v: unknown) => (typeof v === "string" ? v : "")

export function parseBuildOptions(raw: RawBuildOptions): { ok: true; value: BuildOptions } | { ok: false; fieldErrors: FieldErrors } {
  const errors: FieldErrors = {}
  const tags = parseTags(str(raw.tags))
  const buildArgs = parseBuildArgs(str(raw.buildArgs))
  const labels = parseLabels(str(raw.labels))
  const target = validateTarget(str(raw.target))
  if (!tags.ok) errors.tags = [tags.error]
  if (!buildArgs.ok) errors.buildArgs = [buildArgs.error]
  if (!labels.ok) errors.labels = [labels.error]
  if (!target.ok) errors.target = [target.error]
  if (!tags.ok || !buildArgs.ok || !labels.ok || !target.ok) return { ok: false, fieldErrors: errors }
  return {
    ok: true,
    value: {
      tags: tags.value,
      buildArgs: buildArgs.value,
      labels: labels.value,
      target: target.value,
      noCache: raw.noCache === true,
      pull: raw.pull === true,
      push: raw.push === true,
    },
  }
}

// ---------------------------------------------------------------------------
// Sources

export type EditorFile = { path: string; content: string }

export type EditorSource = { kind: "editor"; dockerfile: string; files: EditorFile[] }
export type GitBuildSource = {
  kind: "git"
  url: string
  ref: string
  /** Context directory inside the repository; "" = its root. */
  context: string
  /** Dockerfile relative to the context. */
  dockerfile: string
}
export type UploadSource = { kind: "upload"; filename: string; dockerfile: string; size?: number }
export type BuildSource = EditorSource | GitBuildSource | UploadSource

const byteLength = (s: string) => new TextEncoder().encode(s).length

/** The Dockerfile and extra files typed in the editor. */
export function validateEditorSource(raw: { dockerfile?: unknown; files?: unknown }): { ok: true; value: EditorSource } | { ok: false; fieldErrors: FieldErrors } {
  const dockerfile = str(raw.dockerfile)
  if (!dockerfile.trim()) return { ok: false, fieldErrors: { dockerfile: ["The Dockerfile is empty"] } }
  if (byteLength(dockerfile) > MAX_DOCKERFILE_BYTES) {
    return { ok: false, fieldErrors: { dockerfile: [`The Dockerfile is larger than ${MAX_DOCKERFILE_BYTES / 1024} KB`] } }
  }
  const list = Array.isArray(raw.files) ? raw.files : []
  if (list.length > MAX_EXTRA_FILES) return { ok: false, fieldErrors: { files: [`At most ${MAX_EXTRA_FILES} extra files`] } }
  const files: EditorFile[] = []
  let total = byteLength(dockerfile)
  for (const [i, f] of list.entries()) {
    const name = str((f as { path?: unknown })?.path)
    const content = str((f as { content?: unknown })?.content)
    if (!name.trim() && !content) continue
    const p = validateRelativePath(name, "", "file name")
    if (!p.ok || !p.value) return { ok: false, fieldErrors: { files: [`File ${i + 1}: ${p.ok ? "enter a file name" : p.error}`] } }
    if (p.value === DEFAULT_DOCKERFILE) return { ok: false, fieldErrors: { files: [`File ${i + 1}: the Dockerfile has its own field`] } }
    if (files.some((x) => x.path === p.value)) return { ok: false, fieldErrors: { files: [`File ${i + 1}: ${p.value} is listed twice`] } }
    if (files.some((x) => p.value.startsWith(`${x.path}/`) || x.path.startsWith(`${p.value}/`))) {
      return { ok: false, fieldErrors: { files: [`File ${i + 1}: ${p.value} clashes with another file's folder`] } }
    }
    total += byteLength(content)
    files.push({ path: p.value, content })
  }
  if (total > MAX_EDITOR_CONTEXT_BYTES) {
    return { ok: false, fieldErrors: { files: [`The files are larger than ${MAX_EDITOR_CONTEXT_BYTES / 1024} KB together; upload an archive instead`] } }
  }
  return { ok: true, value: { kind: "editor", dockerfile, files } }
}

/** Repository, ref, context directory and Dockerfile of a Git build (credentials are checked separately). */
export function validateGitBuildSource(
  raw: { url?: unknown; ref?: unknown; context?: unknown; dockerfile?: unknown },
  opts: { allowHttpLoopback?: boolean } = {}
): { ok: true; value: GitBuildSource } | { ok: false; fieldErrors: FieldErrors } {
  const errors: FieldErrors = {}
  const url = validateRepoUrl(str(raw.url), opts)
  const ref = validateRef(str(raw.ref) || "main")
  const context = validateContextPath(str(raw.context))
  const dockerfile = validateDockerfilePath(str(raw.dockerfile))
  if (!url.ok) errors.url = [url.error]
  if (!ref.ok) errors.ref = [ref.error]
  if (!context.ok) errors.context = [context.error]
  if (!dockerfile.ok) errors.gitDockerfile = [dockerfile.error]
  if (!url.ok || !ref.ok || !context.ok || !dockerfile.ok) return { ok: false, fieldErrors: errors }
  return { ok: true, value: { kind: "git", url: url.value, ref: ref.value, context: context.value, dockerfile: dockerfile.value } }
}

/** Upload archives: .tar, .tar.gz/.tgz (also bzip2/xz, which Docker accepts). */
export function isArchiveName(name: string) {
  return /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz)$/i.test(name.trim())
}

/**
 * Whether the first bytes of an upload look like a build context Docker
 * accepts: gzip, bzip2 or xz, or a tar header ("ustar" at offset 257).
 * Needs at least 262 bytes unless compressed.
 */
export function looksLikeArchive(head: Uint8Array): boolean {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return true
  if (head.length >= 3 && head[0] === 0x42 && head[1] === 0x5a && head[2] === 0x68) return true
  if (head.length >= 6 && [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00].every((b, i) => head[i] === b)) return true
  if (head.length < 262) return false
  return String.fromCharCode(...head.subarray(257, 262)) === "ustar"
}

/** One line describing where a build came from (stored, shown in the history). */
export function summarizeSource(source: BuildSource): string {
  switch (source.kind) {
    case "editor":
      return source.files.length ? `Dockerfile editor + ${source.files.length} file(s)` : "Dockerfile editor"
    case "git": {
      const where = [source.context || null, source.dockerfile !== DEFAULT_DOCKERFILE ? source.dockerfile : null].filter(Boolean)
      return `Git ${source.url} @ ${source.ref}${where.length ? ` (${where.join(", ")})` : ""}`
    }
    case "upload":
      return `Upload ${source.filename}${source.dockerfile !== DEFAULT_DOCKERFILE ? ` (${source.dockerfile})` : ""}`
  }
}

// ---------------------------------------------------------------------------
// Build form

export type SourceKind = "editor" | "upload" | "git"

/**
 * Values of the build form. A rebuild starts from those of an earlier build
 * (never with credentials or the archive). Kept here, not in the client
 * component: the server page builds them, and a server component importing
 * a value from a "use client" module only gets a client reference.
 */
export type BuildFormValues = {
  kind: SourceKind
  dockerfile: string
  files: EditorFile[]
  uploadDockerfile: string
  url: string
  ref: string
  context: string
  gitDockerfile: string
  tags: string
  buildArgs: string
  labels: string
  target: string
  noCache: boolean
  pull: boolean
  push: boolean
}

export const EMPTY_BUILD_FORM: BuildFormValues = {
  kind: "editor",
  dockerfile: EXAMPLE_DOCKERFILE,
  files: [],
  uploadDockerfile: DEFAULT_DOCKERFILE,
  url: "",
  ref: "main",
  context: "",
  gitDockerfile: DEFAULT_DOCKERFILE,
  tags: "",
  buildArgs: "",
  labels: "",
  target: "",
  noCache: false,
  pull: false,
  push: false,
}

/** What the build form sends besides its text fields. */
export type BuildFormState = {
  kind: SourceKind
  files: EditorFile[]
  noCache: boolean
  pull: boolean
  push: boolean
  /** The chosen archive (upload source). */
  archive: (Blob & { name: string }) | null
  environmentId: number | undefined
}

/**
 * The request the build form sends: JSON to /api/images/build (editor and
 * Git sources), or the archive itself to /api/images/build/upload with the
 * rest in a header. `field` reads a text field of the form by key (see
 * BuildFormValues). Fails when no valid archive is chosen, or when the
 * header would be too long.
 */
export function buildFormRequest(
  form: BuildFormState,
  field: (key: string) => string
): { ok: true; url: string; init: RequestInit } | { ok: false; error: "archive" | "optionsTooLong" } {
  const options = {
    tags: field("tags"),
    buildArgs: field("buildArgs"),
    labels: field("labels"),
    target: field("target"),
    noCache: form.noCache,
    pull: form.pull,
    push: form.push,
  }
  const { environmentId } = form
  if (form.kind === "upload") {
    const { archive } = form
    if (!archive || !isArchiveName(archive.name)) return { ok: false, error: "archive" }
    const header = encodeURIComponent(JSON.stringify({ environmentId, filename: archive.name, dockerfile: field("uploadDockerfile"), options }))
    if (header.length > MAX_OPTIONS_HEADER) return { ok: false, error: "optionsTooLong" }
    return {
      ok: true,
      url: "/api/images/build/upload",
      init: { method: "POST", body: archive, headers: { "Content-Type": "application/octet-stream", [BUILD_OPTIONS_HEADER]: header } },
    }
  }
  const source =
    form.kind === "editor"
      ? { kind: "editor", dockerfile: field("dockerfile"), files: form.files }
      : {
          kind: "git",
          url: field("url"),
          ref: field("ref"),
          context: field("context"),
          dockerfile: field("gitDockerfile"),
          username: field("username"),
          token: field("token"),
        }
  return {
    ok: true,
    url: "/api/images/build",
    init: { method: "POST", body: JSON.stringify({ environmentId, source, options }), headers: { "Content-Type": "application/json" } },
  }
}

// ---------------------------------------------------------------------------
// Docker's JSON stream

/**
 * Splits a stream of JSON messages (one per line, as Docker writes them for
 * /build, /images/create and /images/{name}/push) across arbitrary chunk
 * boundaries. Lines that aren't JSON come back as { raw }.
 */
export class JsonLineParser {
  private buffer = ""

  constructor(private readonly maxLine = 4 * 1024 * 1024) {}

  push(chunk: string): unknown[] {
    this.buffer += chunk
    const out: unknown[] = []
    let nl: number
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      const parsed = parseLine(line)
      if (parsed !== undefined) out.push(parsed)
    }
    // A runaway line without a newline: hand it over rather than grow forever.
    if (this.buffer.length > this.maxLine) {
      out.push({ raw: this.buffer })
      this.buffer = ""
    }
    return out
  }

  /** Whatever is left once the stream ended. */
  end(): unknown[] {
    const rest = this.buffer
    this.buffer = ""
    const parsed = parseLine(rest)
    return parsed === undefined ? [] : [parsed]
  }
}

/** A line JsonLineParser couldn't parse (or cut off), as opposed to a JSON value. */
export function isUnparsedLine(value: unknown): value is { raw: string } {
  return typeof value === "object" && value !== null && Object.keys(value).length === 1 && typeof (value as { raw?: unknown }).raw === "string"
}

function parseLine(line: string): unknown {
  const text = line.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

export type DockerProgress = { id: string; status: string; progress?: string }

/** What a Docker stream message means for the build/push log. */
export type DockerMessage =
  | { kind: "log"; text: string }
  | { kind: "progress"; progress: DockerProgress }
  | { kind: "error"; message: string }
  | { kind: "image"; id: string }
  | { kind: "pushed"; tag?: string; digest: string }
  | { kind: "ignore" }

type RawMessage = {
  stream?: unknown
  status?: unknown
  id?: unknown
  progress?: unknown
  progressDetail?: { current?: unknown; total?: unknown }
  error?: unknown
  errorDetail?: { message?: unknown }
  aux?: { ID?: unknown; Tag?: unknown; Digest?: unknown }
  raw?: unknown
}

export function interpretDockerMessage(value: unknown): DockerMessage {
  if (!value || typeof value !== "object") return { kind: "ignore" }
  const m = value as RawMessage
  const error = typeof m.errorDetail?.message === "string" && m.errorDetail.message ? m.errorDetail.message : m.error
  if (typeof error === "string" && error) return { kind: "error", message: error }
  if (m.aux && typeof m.aux === "object") {
    if (typeof m.aux.ID === "string" && m.aux.ID) return { kind: "image", id: m.aux.ID }
    if (typeof m.aux.Digest === "string" && m.aux.Digest) {
      return { kind: "pushed", digest: m.aux.Digest, tag: typeof m.aux.Tag === "string" ? m.aux.Tag : undefined }
    }
    return { kind: "ignore" }
  }
  if (typeof m.stream === "string") return m.stream ? { kind: "log", text: m.stream } : { kind: "ignore" }
  if (typeof m.status === "string") {
    const id = typeof m.id === "string" ? m.id : ""
    const detail = m.progressDetail
    const moving = typeof m.progress === "string" || (detail && typeof detail.current === "number")
    if (id && moving) {
      return { kind: "progress", progress: { id, status: m.status, progress: typeof m.progress === "string" ? m.progress : undefined } }
    }
    return { kind: "log", text: `${id ? `${id}: ` : ""}${m.status}\n` }
  }
  if (typeof m.raw === "string") return { kind: "log", text: `${m.raw}\n` }
  return { kind: "ignore" }
}

// ---------------------------------------------------------------------------
// Push errors

export type PushFailure = { message: string; hint?: "registries" }

/**
 * Turns a push error from Docker into something a user can act on: refused
 * logins and missing logins point to the Registries page.
 */
export function describePushError(
  raw: string,
  ctx: { reference: string; registry: string; username?: string | null }
): PushFailure {
  const text = raw.trim()
  const denied = /unauthori[sz]ed|authentication required|no basic auth credentials|access to the resource is denied|denied:|status: 401|status: 403|insufficient_scope/i
  if (denied.test(text)) {
    if (ctx.username) {
      return {
        message: `${ctx.registry} refused the push of ${ctx.reference} for ${ctx.username} (${text}). Check that login under Registries and that it may push to this repository.`,
        hint: "registries",
      }
    }
    return {
      message: `${ctx.registry} requires a login to push ${ctx.reference}, and none is configured for it. Add one under Registries, then push again.`,
      hint: "registries",
    }
  }
  if (/no such image|does not exist locally|An image does not exist/i.test(text)) {
    return { message: `${ctx.reference} doesn't exist in this environment. Tag the image first.` }
  }
  if (/server gave HTTP response to HTTPS client/i.test(text)) {
    return {
      message: `${ctx.registry} only speaks plain HTTP. Add it to the Docker daemon's insecure-registries to push there (${text}).`,
    }
  }
  if (/connection refused|no such host|i\/o timeout|dial tcp/i.test(text)) {
    return { message: `Docker can't reach ${ctx.registry} (${text}).` }
  }
  return { message: text || `Pushing ${ctx.reference} failed` }
}

// ---------------------------------------------------------------------------
// Events streamed to the browser (application/x-ndjson, one per line)

export type PushedTag = { reference: string; digest?: string }

export type BuildStreamEvent =
  /** First event: the history entry (builds only) and what will be produced. */
  | { type: "start"; buildId?: number; tags: string[] }
  /** Output from Docker or git. */
  | { type: "log"; text: string }
  /** A phase Gantry starts (cloning, sending the context, pushing a tag...). */
  | { type: "step"; text: string }
  /** Layer download/upload progress, replaced per id. */
  | { type: "progress"; id: string; status: string; progress?: string }
  /** Last event. */
  | {
      type: "done"
      status: Exclude<BuildStatus, "running">
      imageId?: string
      tags: string[]
      pushed: PushedTag[]
      error?: string
      hint?: "registries"
    }

/** Field errors for the build form as returned with HTTP 400. */
export type BuildRequestError = { error: string; fieldErrors?: FieldErrors }
