import "server-only"

import http from "node:http"
import https from "node:https"
import net from "node:net"

import type { EnvironmentType } from "@/lib/server/db/schema"

export type DockerTarget = {
  type: EnvironmentType
  url: string
  /** PEM material for "tcp" endpoints that require TLS (Docker's --tlsverify). */
  tls?: { ca: string; cert: string; key: string } | null
}

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
  /** Sent as is (e.g. a tar archive) instead of JSON. */
  rawBody?: { data: Buffer; contentType: string }
  timeoutMs?: number
  headers?: Record<string, string>
}

export type DockerTls = NonNullable<DockerTarget["tls"]>

/**
 * Where to connect for a target: a Unix socket, or host/port for "tcp"
 * (plus the PEM material when it uses TLS). Accepts "host:port",
 * "tcp://host:port", "http://host:port" and "https://host:port".
 */
export function connectionOptions(target: DockerTarget): https.RequestOptions {
  if (target.type === "socket") return { socketPath: target.url }
  const raw = /^[a-z]+:\/\//i.test(target.url) ? target.url : `tcp://${target.url}`
  const url = new URL(raw.replace(/^[a-z]+:/i, "http:"))
  const tls = target.tls
  const host = url.hostname
  const port = Number(url.port || (tls ? 2376 : 2375))
  if (!tls) return { host, port }
  return {
    host,
    port,
    ca: tls.ca,
    cert: tls.cert,
    key: tls.key,
    // Verify the daemon's certificate against the CA (and its name/IP).
    rejectUnauthorized: true,
    // SNI must be a hostname; IP literals are verified against the cert's IP SANs.
    servername: net.isIP(host) ? undefined : host,
  }
}

/**
 * The one place that opens a connection to Docker: picks http or https for
 * the target and sets the connection options. Used for plain API calls and
 * for hijacked (Upgrade) exec connections.
 */
export function dockerRequest(
  target: DockerTarget,
  options: Omit<http.RequestOptions, "host" | "hostname" | "port" | "socketPath">,
  onResponse?: (res: http.IncomingMessage) => void
): http.ClientRequest {
  const conn = connectionOptions(target)
  // Over TCP the Host header must name the daemon: Node derives the TLS
  // server name from it. Over a socket any value works.
  const host = target.type === "socket" ? "docker" : `${conn.host}:${conn.port}`
  const opts: https.RequestOptions = {
    ...options,
    ...conn,
    headers: { ...options.headers, Host: host },
  }
  return target.type === "tcp" && target.tls ? https.request(opts, onResponse) : http.request(opts, onResponse)
}

/** Maps a socket/TLS error to a DockerError without leaking anything sensitive. */
export function connectionError(err: NodeJS.ErrnoException): DockerError {
  if (err instanceof DockerError) return err
  const code = err.code ?? err.message
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO|ALTNAME/i.test(code)) {
    return new DockerError(`TLS handshake with Docker failed (${code})`, 502)
  }
  return new DockerError(`Cannot reach Docker (${code})`, 502)
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
  const payload = opts.rawBody?.data ?? (opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body)))
  const contentType = opts.rawBody?.contentType ?? "application/json"

  return new Promise((resolve, reject) => {
    const req = dockerRequest(
      target,
      {
        method,
        path: buildPath(path, opts.query),
        headers: {
          ...opts.headers,
          ...(payload
            ? { "Content-Type": contentType, "Content-Length": payload.length }
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
    req.on("error", (err: NodeJS.ErrnoException) => reject(connectionError(err)))
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
