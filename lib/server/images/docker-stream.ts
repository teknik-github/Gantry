import "server-only"

import type { Readable } from "node:stream"

import { JsonLineParser } from "@/lib/image-build"
import { dockerRaw, DockerError, type DockerTarget } from "@/lib/server/docker/client"
import { dockerStream } from "@/lib/server/docker/stream"

// Streaming Docker calls for builds and pushes: a request through
// lib/server/docker/stream.ts (streamed body, no idle timeout: a build step
// may print nothing for minutes) whose response is handed over message by
// message. An AbortSignal tears the connection down, which makes the daemon
// cancel the build or push.

/** The connection was closed on purpose (cancel, timeout); `reason` says why. */
export class StreamAborted extends Error {
  constructor(public reason: unknown) {
    super("aborted")
  }
}

/**
 * Sends a request and calls `onMessage` for each JSON message of the
 * response. Resolves when the response ends; rejects with a DockerError for
 * HTTP errors, a StreamAborted when `signal` fired, or the body's error
 * (e.g. a ContextError from the size guard).
 */
export async function dockerJsonStream(
  target: DockerTarget,
  opts: {
    method: string
    path: string
    query?: [string, string][]
    headers?: Record<string, string>
    body?: Buffer | Readable
    contentType?: string
    signal?: AbortSignal
    onMessage: (msg: unknown) => void
  }
): Promise<void> {
  const { body, signal } = opts
  const streamed = body && !Buffer.isBuffer(body) ? body : null
  // The body's own error (size limit, unreadable file) is the one to report.
  let bodyError: unknown = null
  streamed?.on("error", (err) => (bodyError ??= err))
  const onAbort = () => streamed?.destroy()
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const res = await dockerStream(target, opts.method, opts.path, {
      query: opts.query,
      headers: opts.headers,
      body: body ? { data: body, contentType: opts.contentType ?? "application/x-tar" } : undefined,
      idleTimeoutMs: 0,
      signal,
    })
    res.setEncoding("utf8")
    const parser = new JsonLineParser()
    for await (const chunk of res as AsyncIterable<string>) {
      for (const msg of parser.push(chunk)) opts.onMessage(msg)
    }
    for (const msg of parser.end()) opts.onMessage(msg)
  } catch (err) {
    if (signal?.aborted) throw new StreamAborted(signal.reason)
    if (bodyError) throw bodyError
    // The response broke off: the daemon or the connection went away.
    if ((err as NodeJS.ErrnoException).code === "ECONNRESET") throw new DockerError("Docker closed the connection", 502)
    throw err
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

/** Docker ids and references in a URL path (already validated). */
export function refPath(reference: string) {
  return reference.split("/").map(encodeURIComponent).join("/")
}

/** POST /images/{id}/tag: adds `repository:tag` to an image. */
export async function tagImage(target: DockerTarget, id: string, repository: string, tag: string) {
  await dockerRaw(target, "POST", `/images/${refPath(id)}/tag`, { query: { repo: repository, tag }, timeoutMs: 60_000 })
}
