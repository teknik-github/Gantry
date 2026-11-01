import "server-only"

import type http from "node:http"
import { Readable } from "node:stream"

import { connectionError, dockerJson, dockerRequest, DockerError, type DockerTarget } from "@/lib/server/docker/client"

/**
 * Streaming access to the Docker API, for responses and request bodies that
 * must not be buffered (dockerRaw caps responses at 64 MB): archive
 * downloads and uploads, full logs, exec output.
 */

type StreamOptions = {
  /** Query parameters; a list of pairs repeats keys (e.g. one `t` per tag). */
  query?: Record<string, string | number | boolean | undefined> | [string, string][]
  headers?: Record<string, string>
  /** JSON body, or a raw body (Buffer or stream) with its content type and length. */
  json?: unknown
  body?: { data: Buffer | AsyncIterable<Buffer>; contentType: string; length?: number }
  /** Idle socket timeout (no data either way), default 60 s; 0 for none. */
  idleTimeoutMs?: number
  signal?: AbortSignal
}

function buildPath(path: string, query?: StreamOptions["query"]) {
  if (!query) return path
  const qs = new URLSearchParams()
  if (Array.isArray(query)) for (const [k, v] of query) qs.append(k, v)
  else for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v))
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

/** Reads a (small) error body and turns it into a DockerError. */
async function errorFrom(res: http.IncomingMessage): Promise<DockerError> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of res as AsyncIterable<Buffer>) {
    size += c.length
    if (size > 64 * 1024) break
    chunks.push(c)
  }
  let message = Buffer.concat(chunks).toString("utf8").trim()
  try {
    message = JSON.parse(message).message ?? message
  } catch {}
  return new DockerError(message || `Docker API error ${res.statusCode}`, res.statusCode ?? 502)
}

/**
 * Sends a request and resolves with the response once its status is known;
 * the caller consumes (or destroys) the body. Statuses >= 400 reject with a
 * DockerError carrying Docker's message.
 */
export function dockerStream(
  target: DockerTarget,
  method: string,
  path: string,
  opts: StreamOptions = {}
): Promise<http.IncomingMessage> {
  const json = opts.json === undefined ? undefined : Buffer.from(JSON.stringify(opts.json))
  const headers: Record<string, string | number> = { ...opts.headers }
  if (json) {
    headers["Content-Type"] = "application/json"
    headers["Content-Length"] = json.length
  } else if (opts.body) {
    headers["Content-Type"] = opts.body.contentType
    if (Buffer.isBuffer(opts.body.data)) headers["Content-Length"] = opts.body.data.length
    else if (opts.body.length !== undefined) headers["Content-Length"] = opts.body.length
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    }
    const req = dockerRequest(
      target,
      { method, path: buildPath(path, opts.query), headers, timeout: opts.idleTimeoutMs ?? 60_000 },
      (res) => {
        if ((res.statusCode ?? 0) >= 400) {
          errorFrom(res).then(fail, fail)
          return
        }
        settled = true
        resolve(res)
      }
    )
    req.on("timeout", () => req.destroy(new DockerError("Docker API request timed out", 504)))
    req.on("error", (err: NodeJS.ErrnoException) => fail(err instanceof DockerError ? err : connectionError(err)))
    if (opts.signal) {
      if (opts.signal.aborted) req.destroy(new DockerError("Request cancelled", 499))
      opts.signal.addEventListener("abort", () => req.destroy(new DockerError("Request cancelled", 499)), { once: true })
    }

    if (json) {
      req.end(json)
    } else if (opts.body && Buffer.isBuffer(opts.body.data)) {
      req.end(opts.body.data)
    } else if (opts.body) {
      const source = Readable.from(opts.body.data)
      source.on("error", (err) => {
        // The upload source failed (client went away, size mismatch): abort so
        // Docker sees a broken archive instead of a complete one.
        req.destroy(err instanceof DockerError ? err : new DockerError(err.message, 400))
      })
      source.pipe(req)
    } else {
      req.end()
    }
  })
}

/** Like dockerStream, but for requests whose (small) body is consumed and dropped. */
export async function dockerSend(target: DockerTarget, method: string, path: string, opts: StreamOptions = {}) {
  const res = await dockerStream(target, method, path, opts)
  res.resume()
  await new Promise<void>((resolve, reject) => {
    res.on("end", resolve)
    res.on("error", reject)
  })
  return res
}

/**
 * Splits Docker's multiplexed stdout/stderr stream incrementally. Frames:
 * [stream, 0, 0, 0, size (uint32 BE)] + payload; they may span chunks.
 */
export class FrameDemuxer {
  private pending: Buffer = Buffer.alloc(0)
  private left = 0
  private stream = 1

  constructor(private onFrame: (stream: number, payload: Buffer) => void) {}

  push(chunk: Buffer) {
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    this.pending = Buffer.alloc(0)
    while (buf.length) {
      if (this.left > 0) {
        const n = Math.min(this.left, buf.length)
        this.onFrame(this.stream, buf.subarray(0, n))
        this.left -= n
        buf = buf.subarray(n)
        continue
      }
      if (buf.length < 8) {
        this.pending = Buffer.from(buf)
        return
      }
      const type = buf[0]
      if (type > 2 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) {
        throw new DockerError("Unexpected data in Docker's output stream", 502)
      }
      this.stream = type
      this.left = buf.readUInt32BE(4)
      buf = buf.subarray(8)
    }
  }
}

export type ExecResult = { exitCode: number; stdout: Buffer; stderr: Buffer; truncated: boolean }

/**
 * Runs a command in a running container (no TTY) and captures stdout and
 * stderr separately, keeping at most `maxBytes` of stdout (the command is
 * cut off beyond that and `truncated` is set).
 */
export async function execCapture(
  target: DockerTarget,
  containerId: string,
  cmd: string[],
  opts: { env?: string[]; user?: string; maxBytes?: number; timeoutMs?: number } = {}
): Promise<ExecResult> {
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024
  const { Id } = await dockerJson<{ Id: string }>(target, "POST", `/containers/${encodeURIComponent(containerId)}/exec`, {
    body: { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, Env: opts.env, User: opts.user },
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000)
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let outBytes = 0
  let errBytes = 0
  let truncated = false
  try {
    const res = await dockerStream(target, "POST", `/exec/${Id}/start`, {
      json: { Detach: false, Tty: false },
      signal: controller.signal,
    })
    const demux = new FrameDemuxer((stream, payload) => {
      if (stream === 2) {
        if (errBytes < 64 * 1024) stderr.push(payload)
        errBytes += payload.length
        return
      }
      if (outBytes + payload.length > maxBytes) {
        truncated = true
        stdout.push(payload.subarray(0, Math.max(0, maxBytes - outBytes)))
        outBytes = maxBytes
        res.destroy()
        return
      }
      stdout.push(Buffer.from(payload))
      outBytes += payload.length
    })
    try {
      for await (const chunk of res as AsyncIterable<Buffer>) {
        demux.push(chunk)
        if (truncated) break
      }
    } catch (err) {
      if (!truncated) throw err
    }
  } catch (err) {
    if (controller.signal.aborted) throw new DockerError("The command in the container timed out", 504)
    throw err
  } finally {
    clearTimeout(timer)
  }
  const info = await dockerJson<{ ExitCode: number | null; Running: boolean }>(target, "GET", `/exec/${Id}/json`)
  return {
    exitCode: info.Running ? -1 : (info.ExitCode ?? -1),
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    truncated,
  }
}

/**
 * A web ReadableStream over an async iterable of chunks, with backpressure;
 * `cleanup` runs exactly once when the stream ends, fails or is cancelled
 * (e.g. the browser aborted the download).
 */
export function toWebStream(source: AsyncIterable<Buffer>, cleanup?: () => void | Promise<void>): ReadableStream<Uint8Array> {
  const it = source[Symbol.asyncIterator]()
  let cleaned = false
  const done = async () => {
    if (cleaned) return
    cleaned = true
    try {
      await cleanup?.()
    } catch (err) {
      console.error("[gantry] stream cleanup failed", err)
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: finished } = await it.next()
        if (finished) {
          controller.close()
          await done()
          return
        }
        controller.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
      } catch (err) {
        controller.error(err)
        await done()
      }
    },
    async cancel() {
      try {
        await it.return?.()
      } finally {
        await done()
      }
    },
  })
}
