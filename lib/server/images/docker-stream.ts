import "server-only"

import type { Readable } from "node:stream"

import { JsonLineParser } from "@/lib/image-build"
import { connectionError, dockerRaw, dockerRequest, DockerError, type DockerTarget } from "@/lib/server/docker/client"

// Streaming Docker calls for builds and pushes. Unlike dockerRaw (buffered,
// 64 MB cap) the response is handed over message by message, the request
// body may be a stream, and an AbortSignal tears the connection down, which
// makes the daemon cancel the build or push.

/** The connection was closed on purpose (cancel, timeout); `reason` says why. */
export class StreamAborted extends Error {
  constructor(public reason: unknown) {
    super("aborted")
  }
}

type Query = [string, string][]

function pathWithQuery(path: string, query: Query) {
  const qs = new URLSearchParams()
  for (const [k, v] of query) qs.append(k, v)
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

/**
 * Sends a request and calls `onMessage` for each JSON message of the
 * response. Resolves when the response ends; rejects with a DockerError for
 * HTTP errors, a StreamAborted when `signal` fired, or the body's error
 * (e.g. a ContextError from the size guard).
 */
export function dockerStream(
  target: DockerTarget,
  opts: {
    method: string
    path: string
    query?: Query
    headers?: Record<string, string>
    body?: Buffer | Readable
    contentType?: string
    signal?: AbortSignal
    onMessage: (msg: unknown) => void
  }
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (err?: unknown) => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener("abort", onAbort)
      if (err) reject(err)
      else resolve()
    }
    const headers: Record<string, string | number> = { ...opts.headers }
    if (opts.body) headers["Content-Type"] = opts.contentType ?? "application/x-tar"
    if (Buffer.isBuffer(opts.body)) headers["Content-Length"] = opts.body.length

    const req = dockerRequest(
      target,
      { method: opts.method, path: pathWithQuery(opts.path, opts.query ?? []), headers },
      (res) => {
        const status = res.statusCode ?? 0
        res.setEncoding("utf8")
        if (status >= 400) {
          let text = ""
          res.on("data", (c: string) => {
            if (text.length < 64 * 1024) text += c
          })
          res.on("end", () => {
            let message = text.trim()
            try {
              message = JSON.parse(message).message ?? message
            } catch {}
            finish(new DockerError(message || `Docker API error ${status}`, status))
          })
          res.on("error", (err) => finish(err))
          return
        }
        const parser = new JsonLineParser()
        res.on("data", (chunk: string) => {
          for (const msg of parser.push(chunk)) opts.onMessage(msg)
        })
        res.on("end", () => {
          for (const msg of parser.end()) opts.onMessage(msg)
          finish()
        })
        // Aborted mid-response: the daemon or the connection went away.
        res.on("aborted", () => finish(opts.signal?.aborted ? new StreamAborted(opts.signal.reason) : new DockerError("Docker closed the connection", 502)))
        res.on("error", (err) => finish(opts.signal?.aborted ? new StreamAborted(opts.signal.reason) : err))
      }
    )

    const onAbort = () => {
      const err = new StreamAborted(opts.signal?.reason)
      finish(err)
      req.destroy(err)
      if (opts.body && !Buffer.isBuffer(opts.body)) opts.body.destroy()
    }
    if (opts.signal?.aborted) return onAbort()
    opts.signal?.addEventListener("abort", onAbort, { once: true })

    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err instanceof StreamAborted || settled) return finish(err)
      finish(err instanceof DockerError ? err : connectionError(err))
    })

    if (!opts.body) req.end()
    else if (Buffer.isBuffer(opts.body)) req.end(opts.body)
    else {
      const body = opts.body
      body.on("error", (err) => {
        // The body failed (size limit, unreadable file): give up on the request.
        finish(err)
        req.destroy(err)
      })
      body.pipe(req)
    }
  })
}

/** Docker ids and references in a URL path (already validated). */
export function refPath(reference: string) {
  return reference.split("/").map(encodeURIComponent).join("/")
}

/** POST /images/{id}/tag: adds `repository:tag` to an image. */
export async function tagImage(target: DockerTarget, id: string, repository: string, tag: string) {
  await dockerRaw(target, "POST", `/images/${refPath(id)}/tag`, { query: { repo: repository, tag }, timeoutMs: 60_000 })
}
