import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import type { ReadableStream as NodeReadableStream } from "node:stream/web"

import type { Kysely } from "kysely"

import { acceptAgent, receiveUpstream } from "@/lib/server/agent/hub"
import type { Database } from "@/lib/server/db/schema"

/**
 * Drops the agent's feature offer from its X-Gantry-Agent-Info header, as a
 * Gantry from before concurrent POSTs and window growth did: its parser kept
 * only the fields it knew.
 */
function withoutOffer(header: string | null): string | null {
  if (!header) return header
  try {
    const info = JSON.parse(Buffer.from(header, "base64url").toString("utf8"))
    delete info.upstreamInflight
    return Buffer.from(JSON.stringify(info)).toString("base64url")
  } catch {
    return header
  }
}

/**
 * Gantry's two agent endpoints on a plain Node HTTP server (what the route
 * handlers in app/api/agent/ do inside Next.js), for tests. With
 * `options.legacy` set it acts like a Gantry from before the negotiated
 * features: agents get a HELLO without them.
 */
export async function startAgentEndpoint(db: Kysely<Database>) {
  const options = { legacy: false }
  const server = http.createServer(async (req, res) => {
    const header = (name: string) => {
      const v = req.headers[name]
      return typeof v === "string" ? v : null
    }
    try {
      if (req.method === "GET" && req.url === "/api/agent/connect") {
        const info = header("x-gantry-agent-info")
        const result = await acceptAgent(db, {
          authorization: header("authorization"),
          info: options.legacy ? withoutOffer(info) : info,
          clientAddress: null,
          remoteAddress: req.socket.remoteAddress ?? null,
        })
        if (!result.ok) {
          res.writeHead(result.status, {
            "Content-Type": "application/json",
            ...(result.retryAfter ? { "Retry-After": String(result.retryAfter) } : {}),
          })
          res.end(JSON.stringify({ error: result.error }))
          return
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream" })
        res.flushHeaders()
        const body = Readable.fromWeb(result.session.downstream as unknown as NodeReadableStream<Uint8Array>)
        body.pipe(res)
        res.on("close", () => result.session.close("the agent disconnected", { notify: false }))
        return
      }
      if (req.method === "POST" && req.url === "/api/agent/upstream") {
        const result = await receiveUpstream({
          session: header("x-gantry-agent-session"),
          authorization: header("authorization"),
          seq: header("x-gantry-agent-seq"),
          contentLength: header("content-length"),
          body: req,
        })
        res.writeHead(result.status, result.error ? { "Content-Type": "application/json" } : {})
        res.end(result.error ? JSON.stringify({ error: result.error }) : undefined)
        return
      }
      res.writeHead(404).end()
    } catch (err) {
      res.writeHead(500).end(String(err))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    options,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/**
 * A tiny stand-in for the Docker daemon on a Unix socket:
 *   GET  /version, /info, /containers/json
 *   GET  /blob?size=N       N bytes of deterministic data (sha256 in a header)
 *   POST /sink              answers with the sha256 and length of the body
 *   GET  /hold              keeps the response open until the client goes away
 *   POST /echo (Upgrade: tcp)  hijacked raw echo, like `docker exec`
 */
export async function startFakeDocker() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-a-docker-"))
  const socket = path.join(dir, "docker.sock")
  const held = new Set<http.ServerResponse>()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://docker")
    if (url.pathname === "/version") return json(res, { Version: "99.0.0-fake", Os: "linux", Arch: "amd64" })
    if (url.pathname === "/info") return json(res, { Name: "fake-host", OperatingSystem: "FakeOS" })
    if (url.pathname === "/containers/json") return json(res, [{ Id: "a".repeat(64), Names: ["/gantry-test-a-fake"] }])
    if (url.pathname === "/blob") {
      const size = Number(url.searchParams.get("size"))
      const data = blob(size)
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": size,
        "X-Sha256": crypto.createHash("sha256").update(data).digest("hex"),
      })
      res.end(data)
      return
    }
    if (url.pathname === "/sink" && req.method === "POST") {
      const hash = crypto.createHash("sha256")
      let length = 0
      req.on("data", (c: Buffer) => {
        hash.update(c)
        length += c.length
      })
      req.on("end", () => json(res, { sha256: hash.digest("hex"), length }))
      return
    }
    if (url.pathname === "/hold") {
      res.writeHead(200, { "Content-Type": "text/plain" })
      res.write("held\n")
      held.add(res)
      res.on("close", () => held.delete(res))
      return
    }
    res.writeHead(404).end()
  })
  server.on("upgrade", (req, sock, head) => {
    sock.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
    if (head.length) sock.write(head)
    sock.pipe(sock)
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return {
    socket,
    held,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      }),
  }
}

function json(res: http.ServerResponse, value: unknown) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length })
  res.end(body)
}

/** Deterministic pseudo-random bytes. */
export function blob(size: number): Buffer {
  const out = Buffer.alloc(size)
  let x = 0x12345678
  for (let i = 0; i < size; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 10_000, what = "condition"): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
