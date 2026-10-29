import https from "node:https"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { docker } from "@/lib/server/docker/api"
import { DockerError, type DockerTarget } from "@/lib/server/docker/client"
import { closeSession, openExecSession, openOutputStream, writeInput } from "@/lib/server/docker/exec"
import { encryptTls, environmentTarget } from "@/lib/server/environment-target"

import { dockerAvailable, removeContainer, startScratchContainer } from "../e2e/docker"
import { generateTlsFixtures, startTlsDockerProxy, type TlsDockerProxy, type TlsFixtures } from "../helpers/tls-docker-proxy"

// Docker over mutual TLS, against a local proxy that requires client
// certificates and forwards to /var/run/docker.sock (see tests/helpers).

const available = await dockerAvailable()

describe.skipIf(!available)("Docker over TLS", () => {
  let fx: TlsFixtures
  let proxy: TlsDockerProxy
  let containerId = ""

  const target = (tls: DockerTarget["tls"], url = proxy.address): DockerTarget => ({ type: "tcp", url, tls })

  beforeAll(async () => {
    fx = generateTlsFixtures()
    proxy = await startTlsDockerProxy({ ca: fx.ca, cert: fx.server.cert, key: fx.server.key })
    // Throwaway container for the exec test (Docker can be slow on a busy host).
    containerId = await startScratchContainer(`gantry-test-b-tls-exec-${Date.now()}`)
  }, 180_000)

  afterAll(async () => {
    if (containerId) await removeContainer(containerId)
    await proxy?.close()
    fx?.cleanup()
  }, 180_000)

  it("pings and reads info with the right certificates", async () => {
    const api = docker(target({ ca: fx.ca, ...fx.client }))
    await expect(api.ping()).resolves.not.toThrow()
    const info = await api.info()
    expect(info.ServerVersion).toMatch(/^\d+\./)
  })

  it("accepts https:// and tcp:// addresses", async () => {
    const tls = { ca: fx.ca, ...fx.client }
    await docker(target(tls, `https://${proxy.address}`)).ping()
    await docker(target(tls, `tcp://localhost:${proxy.port}`)).ping()
  })

  it("rejects a server that the configured CA did not sign", async () => {
    const err = await docker(target({ ca: fx.rogueCa, ...fx.client })).ping().catch((e) => e)
    expect(err).toBeInstanceOf(DockerError)
    expect(err.message).toMatch(/TLS handshake with Docker failed/)
  })

  it("is refused by the daemon with a client certificate from another CA", async () => {
    const err = await docker(target({ ca: fx.ca, ...fx.rogueClient })).ping().catch((e) => e)
    expect(err).toBeInstanceOf(DockerError)
  })

  it("is refused without a client certificate", async () => {
    // Through our client with no cert/key...
    const err = await docker(target({ ca: fx.ca, cert: "", key: "" })).ping().catch((e) => e)
    expect(err).toBeInstanceOf(DockerError)
    // ...and with a bare https request.
    const status = await new Promise<number | string>((resolve) => {
      https
        .get({ host: "127.0.0.1", port: proxy.port, path: "/_ping", ca: fx.ca }, (res) => resolve(res.statusCode ?? 0))
        .on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message))
    })
    expect(status).not.toBe(200)
  })

  it("does not fall back to plain HTTP for a TLS endpoint", async () => {
    await expect(docker(target(null)).ping()).rejects.toBeInstanceOf(DockerError)
  })

  it("connects from an environment row with encrypted certificates", async () => {
    const row = { type: "tcp" as const, url: proxy.address, ...encryptTls({ ca: fx.ca, ...fx.client }) }
    expect(row.tls_key).not.toContain("PRIVATE KEY")
    const t = environmentTarget(row)
    expect(t.tls?.key).toBe(fx.client.key)
    await docker(t).ping()
  })

  it("runs an interactive exec over the TLS connection", async () => {
    const userId = 4242
    const sid = await openExecSession({
      userId,
      target: target({ ca: fx.ca, ...fx.client }),
      containerId,
      cmd: ["/bin/sh"],
      cols: 80,
      rows: 24,
    })
    const abort = new AbortController()
    const reader = openOutputStream(sid, userId, abort.signal).getReader()
    writeInput(sid, userId, "echo gantry-$((40 + 2))\n")

    let output = ""
    const deadline = Date.now() + 15_000
    while (!output.includes("gantry-42") && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      output += Buffer.from(value).toString("utf8")
    }
    expect(output).toContain("gantry-42")

    writeInput(sid, userId, "exit 3\n")
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
    // Give Docker a moment to record the exit code.
    await new Promise((r) => setTimeout(r, 300))
    expect(await closeSession(sid, userId)).toEqual({ exitCode: 3 })
    abort.abort()
  }, 60_000)
})
