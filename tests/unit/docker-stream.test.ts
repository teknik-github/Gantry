import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { DockerError, type DockerTarget } from "@/lib/server/docker/client"
import { dockerJsonStream, StreamAborted } from "@/lib/server/images/docker-stream"

// dockerJsonStream (builds and pushes) against a fake daemon on a Unix socket.

describe("dockerJsonStream", () => {
  let dir: string
  let server: http.Server
  let target: DockerTarget
  const seen: { url: string; body: string; contentType?: string }[] = []

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-dstream-"))
    const socket = path.join(dir, "docker.sock")
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = []
      try {
        if (req.url!.startsWith("/build")) for await (const c of req) chunks.push(c as Buffer)
      } catch {
        return // the client gave up on the upload
      }
      seen.push({ url: req.url!, body: Buffer.concat(chunks).toString(), contentType: req.headers["content-type"] })
      if (req.url!.startsWith("/fail")) {
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ message: "boom from docker" }))
        return
      }
      res.writeHead(200, { "Content-Type": "application/json" })
      if (req.url!.startsWith("/cut")) {
        res.write('{"stream":"one"}\n')
        setTimeout(() => res.socket?.destroy(), 50)
        return
      }
      if (req.url!.startsWith("/hang")) {
        res.write('{"stream":"waiting"}\n')
        return
      }
      // Messages split across writes, plus a line that isn't JSON and no final newline.
      res.write('{"stream":"Step 1/2"}\n{"str')
      setTimeout(() => res.end('eam":"Step 2/2"}\nnot json\n{"aux":{"ID":"sha256:abc"}}'), 20)
    })
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    target = { type: "socket", url: socket }
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("hands over each message, with repeated query keys and the body", async () => {
    const messages: unknown[] = []
    await dockerJsonStream(target, {
      method: "POST",
      path: "/build",
      query: [
        ["t", "a:1"],
        ["t", "b:2"],
      ],
      body: Readable.from([Buffer.from("context")]),
      onMessage: (m) => messages.push(m),
    })
    expect(messages).toEqual([{ stream: "Step 1/2" }, { stream: "Step 2/2" }, { raw: "not json" }, { aux: { ID: "sha256:abc" } }])
    expect(seen.at(-1)).toEqual({ url: "/build?t=a%3A1&t=b%3A2", body: "context", contentType: "application/x-tar" })
  })

  it("rejects with Docker's message on an HTTP error", async () => {
    const err = await dockerJsonStream(target, { method: "POST", path: "/fail", onMessage: () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(DockerError)
    expect(err).toMatchObject({ message: "boom from docker", status: 500 })
  })

  it("rejects with the body's own error", async () => {
    class SizeError extends Error {}
    async function* body() {
      yield Buffer.from("x")
      throw new SizeError("The archive is larger than 1 MB")
    }
    const err = await dockerJsonStream(target, { method: "POST", path: "/build", body: Readable.from(body()), onMessage: () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(SizeError)
  })

  it("rejects with StreamAborted when cancelled mid-response", async () => {
    const controller = new AbortController()
    const messages: unknown[] = []
    const run = dockerJsonStream(target, {
      method: "POST",
      path: "/hang",
      signal: controller.signal,
      onMessage: (m) => {
        messages.push(m)
        controller.abort("user")
      },
    })
    const err = await run.catch((e) => e)
    expect(err).toBeInstanceOf(StreamAborted)
    expect(err.reason).toBe("user")
    expect(messages).toEqual([{ stream: "waiting" }])
  })

  it("rejects at once when already cancelled", async () => {
    const err = await dockerJsonStream(target, { method: "POST", path: "/hang", signal: AbortSignal.abort("gone"), onMessage: () => {} }).catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(StreamAborted)
  })

  it("reports a response that breaks off", async () => {
    const err = await dockerJsonStream(target, { method: "POST", path: "/cut", onMessage: () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(DockerError)
    expect(err.message).toBe("Docker closed the connection")
  })
})
