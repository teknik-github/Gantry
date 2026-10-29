import "server-only"

import http from "node:http"

import type { EnvironmentType } from "@/lib/server/db/schema"

export type DockerTarget = { type: EnvironmentType; url: string }

export class DockerError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
    this.name = "DockerError"
  }
}

type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  timeoutMs?: number
}

export function connectionOptions(target: DockerTarget): http.RequestOptions {
  if (target.type === "socket") return { socketPath: target.url }
  const raw = /^[a-z]+:\/\//i.test(target.url) ? target.url : `tcp://${target.url}`
  const url = new URL(raw.replace(/^tcp:/i, "http:"))
  return { host: url.hostname, port: Number(url.port || 2375) }
}

function buildPath(path: string, query?: RequestOptions["query"]) {
  if (!query) return path
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) qs.set(k, String(v))
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

export function dockerRaw(
  target: DockerTarget,
  method: string,
  path: string,
  opts: RequestOptions = {}
): Promise<{ status: number; body: Buffer }> {
  const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body))

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        ...connectionOptions(target),
        method,
        path: buildPath(path, opts.query),
        headers: {
          Host: "docker",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": payload.length }
            : {}),
        },
        timeout: opts.timeoutMs ?? 30_000,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          const body = Buffer.concat(chunks)
          const status = res.statusCode ?? 0
          if (status >= 400) {
            let message = body.toString("utf8").trim()
            try {
              message = JSON.parse(message).message ?? message
            } catch {}
            reject(new DockerError(message || `Docker API error ${status}`, status))
            return
          }
          resolve({ status, body })
        })
        res.on("error", reject)
      }
    )
    req.on("timeout", () => req.destroy(new DockerError("Docker API request timed out", 504)))
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err instanceof DockerError) return reject(err)
      reject(new DockerError(`Cannot reach Docker (${err.code ?? err.message})`, 502))
    })
    if (payload) req.write(payload)
    req.end()
  })
}

export async function dockerJson<T>(
  target: DockerTarget,
  method: string,
  path: string,
  opts?: RequestOptions
): Promise<T> {
  const { body } = await dockerRaw(target, method, path, opts)
  if (body.length === 0) return undefined as T
  return JSON.parse(body.toString("utf8")) as T
}

/**
 * Splits Docker's multiplexed stdout/stderr stream (used when a container has
 * no TTY) into text. Each frame: [stream, 0, 0, 0, size(uint32 BE)] + payload.
 */
export function demuxLogs(buf: Buffer): string {
  let out = ""
  let offset = 0
  while (offset + 8 <= buf.length) {
    const type = buf[offset]
    const size = buf.readUInt32BE(offset + 4)
    if (type > 2 || buf[offset + 1] !== 0) {
      // Not a multiplexed stream after all.
      return buf.toString("utf8")
    }
    out += buf.subarray(offset + 8, offset + 8 + size).toString("utf8")
    offset += 8 + size
  }
  return out
}
