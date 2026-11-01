import "server-only"

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"

import { ENVIRONMENT_SWITCHED } from "@/lib/messages"
import {
  describePushError,
  interpretDockerMessage,
  parseImageReference,
  summarizeSource,
  type BuildOptions,
  type BuildSource,
  type BuildStreamEvent,
  type DockerProgress,
  type EditorSource,
  type GitBuildSource,
  type PushedTag,
} from "@/lib/image-build"
import { registryAuthHeader, registryOf } from "@/lib/registry"
import { paddedBase64Url, registryConfigHeader } from "@/lib/registry-config"
import { audit } from "@/lib/server/audit"
import type { CurrentUser } from "@/lib/server/auth/dal"
import type { Environment } from "@/lib/server/db/schema"
import { DockerError, type DockerTarget } from "@/lib/server/docker/client"
import { environmentTarget } from "@/lib/server/environments"
import {
  activeBuildCount,
  finishBuild,
  insertBuild,
  markActive,
  markDone,
  MAX_STORED_LOG,
} from "@/lib/server/images/builds"
import { ContextError, directoryContext, editorContext, formatLimit, resolveInside, uploadGuard } from "@/lib/server/images/context"
import { dockerJsonStream, refPath, StreamAborted } from "@/lib/server/images/docker-stream"
import { allRegistryCredentials, credentialsForImage } from "@/lib/server/registries"
import { OutputBuffer } from "@/lib/server/stacks/compose"
import { GitError, syncCheckout, type GitCredentials } from "@/lib/server/stacks/git"

// Runs image builds and pushes for the route handlers in app/api/images/*
// and streams their progress to the browser as JSON lines
// (BuildStreamEvent). The work is tied to the HTTP request: when the browser
// closes it (Cancel, navigating away) the Docker request is closed too, and
// the daemon stops the build (the running step's container is killed).

function envNumber(name: string, fallback: number, min: number) {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= min ? n : fallback
}

/** Limits, read when used (GANTRY_BUILD_* environment variables). */
export function buildLimits() {
  return {
    /** Uploaded archives and Git contexts, in bytes. */
    maxContextBytes: envNumber("GANTRY_BUILD_MAX_CONTEXT_MB", 512, 1) * 1024 * 1024,
    /** A build (clone, build and push) is stopped after this long. */
    timeoutMs: envNumber("GANTRY_BUILD_TIMEOUT_MINUTES", 60, 1) * 60_000,
    /** Builds running at once in this Gantry process. */
    maxConcurrent: Math.floor(envNumber("GANTRY_BUILD_CONCURRENCY", 2, 1)),
  }
}

const json = (status: number, body: object) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } })

/** Checks that the build/push runs on the environment the page showed and that it is a Docker one. */
export function dockerTargetFor(environment: Environment | null, expectedId: number | undefined): DockerTarget | Response {
  if (!environment) return json(404, { error: "No Docker environment configured" })
  if (expectedId !== undefined && environment.id !== expectedId) return json(409, { error: ENVIRONMENT_SWITCHED })
  try {
    return environmentTarget(environment)
  } catch (err) {
    if (err instanceof DockerError) return json(err.status, { error: err.message })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Streaming

type Io = {
  signal: AbortSignal
  send: (event: BuildStreamEvent) => void
  log: (text: string) => void
  step: (text: string) => void
  progress: (p: DockerProgress) => void
  /** What was logged so far (the end of it), for the build history. */
  output: OutputBuffer
}

/**
 * A response streaming the events `work` sends. Cancelled when the browser
 * closes the request (or reads no more), and after `timeoutMs`.
 */
function eventStream(requestSignal: AbortSignal, timeoutMs: number, work: (io: Io) => Promise<void>): Response {
  const controller = new AbortController()
  const abort = (reason: "cancelled" | "timeout") => {
    if (!controller.signal.aborted) controller.abort(reason)
  }
  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      const send = (event: BuildStreamEvent) => {
        if (closed) return
        try {
          c.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        } catch {
          closed = true
        }
      }
      const output = new OutputBuffer(MAX_STORED_LOG)
      const io: Io = {
        signal: controller.signal,
        send,
        output,
        log: (text) => {
          output.append(text)
          send({ type: "log", text })
        },
        step: (text) => {
          output.append(`> ${text}\n`)
          send({ type: "step", text })
        },
        progress: (p) => send({ type: "progress", ...p }),
      }
      const onRequestAbort = () => abort("cancelled")
      if (requestSignal.aborted) abort("cancelled")
      else requestSignal.addEventListener("abort", onRequestAbort, { once: true })
      const timer = setTimeout(() => abort("timeout"), timeoutMs)

      void work(io)
        .catch((err) => console.error("[gantry] image stream failed", err))
        .finally(() => {
          clearTimeout(timer)
          requestSignal.removeEventListener("abort", onRequestAbort)
          if (closed) return
          closed = true
          try {
            c.close()
          } catch {
            // The client went away.
          }
        })
    },
    cancel() {
      closed = true
      abort("cancelled")
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      // no-transform keeps compression from buffering the stream.
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}

/** A failure with a message for the user (and maybe a pointer to Registries). */
class StepFailure extends Error {
  constructor(
    message: string,
    public hint?: "registries"
  ) {
    super(message)
  }
}

/** Errors a stream raises when the client closed the connection (e.g. mid-upload). */
function isAbortLike(err: unknown) {
  const e = err as NodeJS.ErrnoException | null
  return Boolean(e && (e.name === "AbortError" || e.code === "ABORT_ERR" || e.code === "ECONNRESET" || e.message === "aborted"))
}

function abortMessage(signal: AbortSignal, timeoutMs: number) {
  return signal.reason === "timeout" ? `Stopped after ${Math.round(timeoutMs / 60_000)} minute(s) (GANTRY_BUILD_TIMEOUT_MINUTES)` : null
}

function failureMessage(err: unknown, what: string): { message: string; hint?: "registries" } {
  if (err instanceof StepFailure) return { message: err.message, hint: err.hint }
  if (err instanceof ContextError || err instanceof GitError || err instanceof DockerError) return { message: err.message }
  console.error(`[gantry] ${what} failed`, err)
  return { message: `${what} failed unexpectedly. Check the server logs.` }
}

// ---------------------------------------------------------------------------
// Push

/**
 * Pushes `reference` with the stored login of its registry (if any),
 * reporting progress through `io`. Throws a StepFailure with a readable
 * message (pointing to Registries for login problems).
 */
async function pushReference(target: DockerTarget, reference: string, io: Io): Promise<PushedTag> {
  const parsed = parseImageReference(reference)
  if (!parsed.ok) throw new StepFailure(parsed.error)
  const { repository, tag } = parsed.value
  const registry = registryOf(reference)
  const cred = await credentialsForImage(reference)
  io.step(cred ? `Pushing ${reference} to ${registry} as ${cred.username}` : `Pushing ${reference} to ${registry} (no login stored for it)`)
  let failure: string | null = null
  let digest: string | undefined
  try {
    await dockerJsonStream(target, {
      method: "POST",
      path: `/images/${refPath(repository)}/push`,
      query: [["tag", tag]],
      // The daemon wants the header even for registries without a login.
      headers: { "X-Registry-Auth": cred ? registryAuthHeader(cred) : paddedBase64Url("{}") },
      signal: io.signal,
      onMessage: (raw) => {
        const msg = interpretDockerMessage(raw)
        if (msg.kind === "log") io.log(msg.text)
        else if (msg.kind === "progress") io.progress(msg.progress)
        else if (msg.kind === "error") failure ??= msg.message
        else if (msg.kind === "pushed") digest = msg.digest
      },
    })
  } catch (err) {
    if (err instanceof DockerError) failure = err.message
    else throw err
  }
  if (failure) {
    const described = describePushError(failure, { reference, registry, username: cred?.username })
    io.log(`${failure}\n`)
    throw new StepFailure(described.message, described.hint)
  }
  io.step(`Pushed ${reference}${digest ? ` (${digest})` : ""}`)
  return { reference, digest }
}

/** Streams a push of one tag (Images → Push). Audited as image.push. */
export async function startPush(opts: {
  user: CurrentUser
  target: DockerTarget
  reference: string
  requestSignal: AbortSignal
}): Promise<Response> {
  await audit(opts.user, "image.push", opts.reference)
  const { timeoutMs } = buildLimits()
  return eventStream(opts.requestSignal, timeoutMs, async (io) => {
    io.send({ type: "start", tags: [opts.reference] })
    try {
      const pushed = await pushReference(opts.target, opts.reference, io)
      io.send({ type: "done", status: "success", tags: [opts.reference], pushed: [pushed] })
    } catch (err) {
      if (io.signal.aborted || err instanceof StreamAborted) {
        const timeout = abortMessage(io.signal, timeoutMs)
        io.send({ type: "done", status: timeout ? "error" : "cancelled", tags: [opts.reference], pushed: [], error: timeout ?? "Push cancelled" })
        return
      }
      const f = failureMessage(err, "The push")
      io.send({ type: "done", status: "error", tags: [opts.reference], pushed: [], error: f.message, hint: f.hint })
    }
  })
}

// ---------------------------------------------------------------------------
// Build

/** The tar archive Docker builds from, and the Dockerfile's path in it. */
type PreparedContext = { body: Buffer | Readable; dockerfile: string; cleanup?: () => Promise<void> }

export type ContextProvider = (io: Io) => Promise<PreparedContext>

export function editorProvider(source: EditorSource): ContextProvider {
  return async (io) => {
    const body = editorContext(source)
    io.step(`Sending the Dockerfile${source.files.length ? ` and ${source.files.length} file(s)` : ""} (${formatLimit(body.length)})`)
    return { body, dockerfile: "Dockerfile" }
  }
}

/** Streams an uploaded archive straight to Docker (never stored), with the size/format guard. */
export function uploadProvider(body: ReadableStream<Uint8Array>, dockerfile: string, size: number | null): ContextProvider {
  return async (io) => {
    const { maxContextBytes } = buildLimits()
    const source = Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>)
    const guard = uploadGuard(maxContextBytes)
    source.on("error", (err) => guard.destroy(err))
    source.pipe(guard)
    io.step(`Sending the uploaded archive${size ? ` (${formatLimit(size)})` : ""}`)
    return { body: guard, dockerfile }
  }
}

/** Output sink for git that also streams each chunk to the browser. */
class LiveOutput extends OutputBuffer {
  constructor(private readonly onText: (text: string) => void) {
    super(64 * 1024)
  }
  override append(text: string) {
    super.append(text)
    this.onText(text)
  }
}

/** Shallow clone (stacks' git code: private temp HOME, credentials via helper), then tar the context. */
export function gitProvider(source: GitBuildSource, credentials: GitCredentials | null): ContextProvider {
  return async (io) => {
    const { maxContextBytes } = buildLimits()
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gantry-build-"))
    const cleanup = () => fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    try {
      io.step(`Cloning ${source.url} @ ${source.ref}`)
      // syncCheckout redacts the token from git's output before it gets here.
      await syncCheckout(dir, { url: source.url, ref: source.ref, credentials }, new LiveOutput(io.log), { signal: io.signal })
      if (io.signal.aborted) throw new StreamAborted(io.signal.reason)
      const repo = path.join(dir, "repo")
      const contextDir = await resolveInside(repo, source.context, "The context directory")
      const st = await fs.stat(contextDir)
      if (!st.isDirectory()) throw new ContextError(`${source.context} is not a directory`)
      const dockerfile = await resolveInside(contextDir, source.dockerfile, "The Dockerfile")
      if (!(await fs.stat(dockerfile)).isFile()) throw new ContextError(`${source.dockerfile} is not a file`)
      if (path.relative(contextDir, dockerfile).startsWith("..")) {
        throw new ContextError(`The Dockerfile must be inside the context directory`)
      }
      io.step(`Sending the context${source.context ? ` ${source.context}/` : ""} (up to ${formatLimit(maxContextBytes)})`)
      return { body: directoryContext(contextDir, { maxBytes: maxContextBytes }), dockerfile: source.dockerfile, cleanup }
    } catch (err) {
      await cleanup()
      throw err
    }
  }
}

/**
 * Starts a build and returns the streaming response (or an error response
 * when too many builds run). Records it in the history and audits it.
 */
export async function startBuild(opts: {
  user: CurrentUser
  environment: Environment
  target: DockerTarget
  source: BuildSource
  options: BuildOptions
  context: ContextProvider
  requestSignal: AbortSignal
}): Promise<Response> {
  const limits = buildLimits()
  if (activeBuildCount() >= limits.maxConcurrent) {
    return json(429, { error: `${limits.maxConcurrent} build(s) are already running; try again when one has finished` })
  }
  const { user, environment, target, source, options } = opts
  const summary = summarizeSource(source)
  const buildId = await insertBuild({ environmentId: environment.id, user, source, sourceSummary: summary, options })
  markActive(buildId)
  await audit(user, "image.build", `${options.tags.join(" ")} from ${summary}`)

  return eventStream(opts.requestSignal, limits.timeoutMs, async (io) => {
    io.send({ type: "start", buildId, tags: options.tags })
    let imageId: string | undefined
    const pushed: PushedTag[] = []
    let prepared: PreparedContext | null = null
    let result: { status: "success" | "error" | "cancelled"; error?: string; hint?: "registries" }
    try {
      prepared = await opts.context(io)
      const query: [string, string][] = [
        // The classic builder: its JSON stream carries the output, errors and the image id.
        ["version", "1"],
        ["dockerfile", prepared.dockerfile],
        ["rm", "1"],
        ["forcerm", "1"],
        ...options.tags.map((t): [string, string] => ["t", t]),
      ]
      if (Object.keys(options.buildArgs).length) query.push(["buildargs", JSON.stringify(options.buildArgs)])
      if (Object.keys(options.labels).length) query.push(["labels", JSON.stringify(options.labels)])
      if (options.target) query.push(["target", options.target])
      if (options.noCache) query.push(["nocache", "1"])
      if (options.pull) query.push(["pull", "1"])
      const creds = await allRegistryCredentials()
      io.step(`Building on ${environment.name}${creds.length ? ` (with ${creds.length} registry login(s) for base images)` : ""}`)

      let buildError: string | null = null
      await dockerJsonStream(target, {
        method: "POST",
        path: "/build",
        query,
        headers: creds.length ? { "X-Registry-Config": registryConfigHeader(creds) } : {},
        body: prepared.body,
        signal: io.signal,
        onMessage: (raw) => {
          const msg = interpretDockerMessage(raw)
          if (msg.kind === "log") io.log(msg.text)
          else if (msg.kind === "progress") io.progress(msg.progress)
          else if (msg.kind === "image") imageId = msg.id
          else if (msg.kind === "error") {
            buildError ??= msg.message
            io.log(`ERROR: ${msg.message}\n`)
          }
        },
      })
      if (buildError) throw new StepFailure(buildError)
      if (!imageId) throw new StepFailure("Docker finished without reporting an image id")
      io.step(`Built ${imageId} as ${options.tags.join(", ")}`)

      if (options.push) {
        for (const tag of options.tags) {
          await audit(user, "image.push", tag)
          pushed.push(await pushReference(target, tag, io))
        }
      }
      result = { status: "success" }
    } catch (err) {
      if (io.signal.aborted || err instanceof StreamAborted || (opts.requestSignal.aborted && isAbortLike(err))) {
        const timeout = abortMessage(io.signal, limits.timeoutMs)
        result = timeout ? { status: "error", error: timeout } : { status: "cancelled", error: "Build cancelled" }
      } else {
        const f = failureMessage(err, "The build")
        result = { status: "error", error: imageId && options.push ? `Built ${imageId}, but: ${f.message}` : f.message, hint: f.hint }
      }
      io.step(result.error ?? "Failed")
    } finally {
      await prepared?.cleanup?.()
    }
    markDone(buildId)
    await finishBuild(buildId, {
      status: result.status,
      imageId: imageId ?? null,
      error: result.error ?? null,
      log: io.output.toString(),
    }).catch((err) => console.error("[gantry] could not save build", buildId, err))
    io.send({ type: "done", status: result.status, imageId, tags: options.tags, pushed, error: result.error, hint: result.hint })
  })
}
