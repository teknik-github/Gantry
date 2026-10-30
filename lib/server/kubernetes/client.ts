import "server-only"

import https from "node:https"
import net from "node:net"

/**
 * Minimal Kubernetes API client on node:https: bearer token and/or client
 * certificate, verified against the cluster CA (or not at all when the
 * environment says so). JSON in, JSON (or text, for logs) out.
 */

export type KubeTarget = {
  /** API server base URL, https only, optionally with a path prefix (Rancher-style proxies). */
  server: string
  token?: string | null
  /** PEM CA bundle; null = the system trust store. */
  ca?: string | null
  cert?: string | null
  key?: string | null
  /** Skip verification of the API server's certificate. */
  insecure?: boolean
}

export class KubeError extends Error {
  constructor(
    message: string,
    public status: number,
    /** `reason` of a Kubernetes Status ("NotFound", "Forbidden", "AlreadyExists", ...). */
    public reason?: string
  ) {
    super(message)
    this.name = "KubeError"
  }
}

export type KubeRequest = {
  method: string
  /** Absolute API path, e.g. /api/v1/namespaces. Callers encode path segments. */
  path: string
  /** Arrays repeat the parameter (exec's `command`). */
  query?: Record<string, string | number | boolean | readonly string[] | undefined>
  /** Objects are sent as JSON; strings as they are. */
  body?: unknown
  /** Defaults to application/json when there is a body. */
  contentType?: string
  accept?: string
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000
/** Big clusters can return a lot; refuse rather than run out of memory. */
export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

/** Parses and normalises an API server URL: https only, no query/fragment, no trailing slash. */
export function parseServerUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new KubeError("The API server address must be a URL such as https://10.0.0.5:6443", 400)
  }
  if (url.protocol !== "https:") throw new KubeError("The API server must use https://", 400)
  if (url.username || url.password) throw new KubeError("Put credentials in the token field, not in the URL", 400)
  if (url.search || url.hash) throw new KubeError("The API server address can't have a query or fragment", 400)
  url.pathname = url.pathname.replace(/\/+$/, "")
  return url
}

/** https.request options and payload for a request; pure, so it can be unit tested. */
export function buildRequest(target: KubeTarget, req: KubeRequest): { options: https.RequestOptions; payload?: Buffer } {
  const base = parseServerUrl(target.server)
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const item of v) qs.append(k, item)
    else qs.set(k, String(v))
  }
  const query = qs.toString()

  let payload: Buffer | undefined
  if (req.body !== undefined) {
    payload = Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body))
  }

  const headers: Record<string, string | number> = { Accept: req.accept ?? "application/json" }
  if (target.token) headers.Authorization = `Bearer ${target.token}`
  if (payload) {
    headers["Content-Type"] = req.contentType ?? "application/json"
    headers["Content-Length"] = payload.length
  }

  const host = base.hostname.replace(/^\[|\]$/g, "")
  const options: https.RequestOptions = {
    method: req.method,
    host,
    port: Number(base.port || 443),
    path: `${base.pathname.replace(/\/+$/, "")}${req.path}${query ? `?${query}` : ""}`,
    headers,
    timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    rejectUnauthorized: !target.insecure,
    // SNI must be a hostname; IP literals are verified against the cert's IP SANs.
    servername: net.isIP(host) ? undefined : host,
    // A fresh connection per request: options differ per cluster and pages make few calls.
    agent: false,
  }
  if (target.ca) options.ca = target.ca
  if (target.cert && target.key) {
    options.cert = target.cert
    options.key = target.key
  }
  return { options, payload }
}

/** Maps a socket/TLS error to a KubeError without leaking anything sensitive. */
export function connectionError(err: NodeJS.ErrnoException): KubeError {
  if (err instanceof KubeError) return err
  const code = err.code ?? err.message
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO|ALTNAME|EPROTO/i.test(code)) {
    return new KubeError(`TLS handshake with the Kubernetes API failed (${code})`, 502)
  }
  return new KubeError(`Cannot reach the Kubernetes API (${code})`, 502)
}

/** Turns an error response (usually a Status object) into a readable message. */
export function errorFromResponse(status: number, body: string): KubeError {
  let message = body.trim()
  let reason: string | undefined
  try {
    const parsed = JSON.parse(message) as { kind?: string; message?: string; reason?: string }
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.message === "string" && parsed.message) message = parsed.message
      if (typeof parsed.reason === "string") reason = parsed.reason
    }
  } catch {}
  if (status === 401) {
    return new KubeError("The Kubernetes API rejected the credentials (401 Unauthorized)", 401, reason ?? "Unauthorized")
  }
  if (message.length > 1000) message = `${message.slice(0, 1000)}…`
  return new KubeError(message || `Kubernetes API error ${status}`, status, reason)
}

/** Sends a request and returns the raw response body. Throws KubeError for >= 400 and connection failures. */
export function kubeRaw(target: KubeTarget, req: KubeRequest): Promise<{ status: number; body: Buffer; contentType: string }> {
  let built: ReturnType<typeof buildRequest>
  try {
    built = buildRequest(target, req)
  } catch (err) {
    return Promise.reject(err)
  }
  const { options, payload } = built

  return new Promise((resolve, reject) => {
    const request = https.request(options, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on("data", (c: Buffer) => {
        size += c.length
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new KubeError("The Kubernetes API response is too large", 502))
          return
        }
        chunks.push(c)
      })
      res.on("end", () => {
        const body = Buffer.concat(chunks)
        const status = res.statusCode ?? 0
        if (status >= 400) return reject(errorFromResponse(status, body.toString("utf8")))
        resolve({ status, body, contentType: String(res.headers["content-type"] ?? "") })
      })
      res.on("error", (err) => reject(connectionError(err)))
    })
    request.on("timeout", () => request.destroy(new KubeError("The Kubernetes API did not answer in time", 504)))
    request.on("error", (err: NodeJS.ErrnoException) => reject(connectionError(err)))
    request.end(payload)
  })
}

/** kubeRaw for JSON endpoints. */
export async function kubeJson<T>(target: KubeTarget, req: KubeRequest): Promise<{ status: number; data: T }> {
  const res = await kubeRaw(target, req)
  try {
    return { status: res.status, data: JSON.parse(res.body.toString("utf8")) as T }
  } catch {
    throw new KubeError("The Kubernetes API returned something that isn't JSON", 502)
  }
}

/**
 * Opens a long-lived response (watch, log follow) and resolves once the
 * headers arrive with a 2xx status; the caller reads the body as it streams.
 * Aborting `signal` closes the connection. `idleTimeoutMs` ends a stream
 * that stays silent that long (dead peers, half-open connections).
 */
export function kubeStream(
  target: KubeTarget,
  req: KubeRequest & { idleTimeoutMs?: number },
  signal?: AbortSignal
): Promise<import("node:http").IncomingMessage> {
  let built: ReturnType<typeof buildRequest>
  try {
    built = buildRequest(target, { ...req, timeoutMs: req.idleTimeoutMs ?? 0 })
  } catch (err) {
    return Promise.reject(err)
  }
  const { options, payload } = built
  if (signal?.aborted) return Promise.reject(new KubeError("Aborted", 499))

  return new Promise((resolve, reject) => {
    const request = https.request(options, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 400) {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.length < 64 && chunks.push(c))
        res.on("end", () => reject(errorFromResponse(status, Buffer.concat(chunks).toString("utf8"))))
        res.on("error", (err) => reject(connectionError(err)))
        return
      }
      resolve(res)
    })
    const onAbort = () => request.destroy(new KubeError("Aborted", 499))
    signal?.addEventListener("abort", onAbort, { once: true })
    request.on("close", () => signal?.removeEventListener("abort", onAbort))
    request.on("timeout", () => request.destroy(new KubeError("The Kubernetes API stream went silent", 504)))
    request.on("error", (err: NodeJS.ErrnoException) => reject(connectionError(err)))
    request.end(payload)
  })
}
