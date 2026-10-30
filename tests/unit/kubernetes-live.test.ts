import crypto from "node:crypto"
import https from "node:https"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { eventAffectsPath, type KubeLiveEvent } from "@/lib/live"
import type { HelmReleaseSecret, KubeApi } from "@/lib/server/kubernetes/api"
import { KubeError } from "@/lib/server/kubernetes/client"
import { openOutputStream, closeSession, registerSession, writeInput, resizeSession, ExecSessionError } from "@/lib/server/exec-sessions"
import { connectWebSocket, execRequest, openPodExecSession } from "@/lib/server/kubernetes/exec"
import {
  decodeRelease,
  encodeRelease,
  getRelease,
  latestRevisions,
  listReleases,
  uninstallRelease,
  type HelmReleaseRecord,
} from "@/lib/server/kubernetes/helm"
import { ndjsonSplitter, runWatch, type WatchEvent, type WatchTransport } from "@/lib/server/kubernetes/watch"
import {
  acceptFor,
  CHANNEL,
  channelMessage,
  encodeFrame,
  exitCodeFromStatus,
  FrameParser,
  OPCODE,
  parseChannelMessage,
  resizeMessage,
  WebSocketProtocolError,
  type WsMessage,
} from "@/lib/server/kubernetes/ws"

import { generateTlsFixtures, type TlsFixtures } from "../helpers/tls-docker-proxy"

let fx: TlsFixtures
beforeAll(() => {
  fx = generateTlsFixtures()
})
afterAll(() => fx?.cleanup())

// ------------------------------------------------------------------ watches

/** A scripted transport: each watch() call plays the next script (events, then end or throw). */
function fakeTransport(lists: string[], watches: (WatchEvent[] | Error)[]) {
  const calls: { list: number; watch: string[] } = { list: 0, watch: [] }
  const transport: WatchTransport = {
    async list() {
      calls.list++
      const rv = lists.shift()
      if (!rv) throw new Error("no more lists")
      return rv
    },
    async watch(rv, onEvent, signal) {
      calls.watch.push(rv)
      const script = watches.shift()
      if (!script) {
        // Nothing left: behave like an idle stream until aborted.
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        return
      }
      if (script instanceof Error) throw script
      for (const e of script) if (onEvent(e) === false) return
    },
  }
  return { transport, calls }
}

const ev = (type: WatchEvent["type"], name: string, rv: string, extra: Partial<WatchEvent["object"]> = {}): WatchEvent => ({
  type,
  object: { metadata: { name, namespace: "web", resourceVersion: rv }, ...extra },
})

async function collect(transport: WatchTransport, until: (events: KubeLiveEvent[]) => boolean, opts = {}) {
  const events: KubeLiveEvent[] = []
  const abort = new AbortController()
  const done = runWatch(transport, "Pod", (e) => {
    events.push(e)
    if (until(events)) abort.abort()
  }, abort.signal, { quickEndMs: 0, ...opts })
  await done
  return events
}

describe("runWatch", () => {
  it("emits changes, follows bookmarks and re-watches from the last version when the stream ends", async () => {
    const { transport, calls } = fakeTransport(
      ["100"],
      [
        [ev("ADDED", "a", "101"), ev("BOOKMARK", "", "150")],
        [ev("MODIFIED", "a", "160"), ev("DELETED", "a", "170")],
      ]
    )
    const events = await collect(transport, (e) => e.length === 3)
    expect(events).toEqual([
      { type: "kubernetes", kind: "Pod", action: "added", namespace: "web", name: "a" },
      { type: "kubernetes", kind: "Pod", action: "modified", namespace: "web", name: "a" },
      { type: "kubernetes", kind: "Pod", action: "deleted", namespace: "web", name: "a" },
    ])
    // Bookmarks move the version on without an event.
    expect(calls.watch).toEqual(["100", "150"])
    expect(calls.list).toBe(1)
  })

  it("re-lists after 410 Gone and tells the pages to refresh", async () => {
    const { transport, calls } = fakeTransport(
      ["100", "500"],
      [[ev("ADDED", "a", "101"), { type: "ERROR", object: { code: 410, reason: "Expired", message: "too old resource version" } }], [ev("ADDED", "b", "501")]]
    )
    const events = await collect(transport, (e) => e.some((x) => x.name === "b"))
    expect(events.map((e) => e.action)).toEqual(["added", "resync", "added"])
    expect(calls.list).toBe(2)
    expect(calls.watch).toEqual(["100", "500"])
  })

  it("starts from a given version without listing", async () => {
    const { transport, calls } = fakeTransport([], [[ev("ADDED", "a", "8")]])
    await collect(transport, (e) => e.length === 1, { resourceVersion: "7" })
    expect(calls.list).toBe(0)
    expect(calls.watch).toEqual(["7"])
  })

  it("fails on other watch errors and on connection errors (the hub reconnects with backoff)", async () => {
    const forbidden = fakeTransport(["1"], [[{ type: "ERROR", object: { code: 403, message: "forbidden" } }]])
    await expect(collect(forbidden.transport, () => false)).rejects.toMatchObject({ status: 403, message: "forbidden" })
    const reset = fakeTransport(["1"], [new KubeError("Cannot reach the Kubernetes API (ECONNRESET)", 502)])
    await expect(collect(reset.transport, () => false)).rejects.toThrow(/ECONNRESET/)
  })

  it("gives up when watches keep ending immediately", async () => {
    const { transport } = fakeTransport(["1"], [[], [], [], [], [], []])
    let t = 0
    await expect(collect(transport, () => false, { quickEndMs: 10, now: () => t++ })).rejects.toThrow(/keeps ending immediately/)
  })
})

describe("ndjsonSplitter", () => {
  it("joins lines split across chunks", () => {
    const out: unknown[] = []
    const s = ndjsonSplitter((v) => out.push(v))
    s.push('{"type":"ADD')
    s.push('ED"}\n{"type":"B"}\n\n{"ty')
    expect(out).toEqual([{ type: "ADDED" }, { type: "B" }])
    s.push('pe":"C"}\n')
    expect(out).toHaveLength(3)
  })
})

describe("live events on Kubernetes pages", () => {
  const e = (kind: KubeLiveEvent["kind"], extra: Partial<KubeLiveEvent> = {}): KubeLiveEvent => ({
    type: "kubernetes",
    kind,
    action: "modified",
    namespace: "web",
    name: "api-1",
    ...extra,
  })

  it("refreshes only pages that show the kind", () => {
    expect(eventAffectsPath(e("Pod"), "/kubernetes/pods")).toBe(true)
    expect(eventAffectsPath(e("Pod"), "/kubernetes")).toBe(true)
    expect(eventAffectsPath(e("Pod"), "/kubernetes/workloads")).toBe(false)
    expect(eventAffectsPath(e("Deployment"), "/kubernetes/workloads")).toBe(true)
    expect(eventAffectsPath(e("Ingress"), "/kubernetes/services")).toBe(true)
    expect(eventAffectsPath(e("Event"), "/kubernetes/events")).toBe(true)
    expect(eventAffectsPath(e("Pod"), "/kubernetes/apply")).toBe(false)
    expect(eventAffectsPath(e("Pod"), "/containers")).toBe(false)
  })

  it("a pod page only follows its own pod (and resyncs)", () => {
    expect(eventAffectsPath(e("Pod"), "/kubernetes/pods/web/api-1")).toBe(true)
    expect(eventAffectsPath(e("Pod", { name: "api-2" }), "/kubernetes/pods/web/api-1")).toBe(false)
    expect(eventAffectsPath(e("Pod", { action: "resync", name: undefined }), "/kubernetes/pods/web/api-1")).toBe(true)
  })

  it("Docker events don't touch Kubernetes pages", () => {
    expect(eventAffectsPath({ type: "container", action: "start", id: "abc" }, "/kubernetes/pods")).toBe(false)
  })
})

// ---------------------------------------------------------------- WebSocket

describe("WebSocket framing", () => {
  it("round-trips masked and unmasked frames of every length class", () => {
    for (const len of [0, 5, 125, 126, 300, 65535, 65536, 200_000]) {
      const payload = crypto.randomBytes(len)
      const out: WsMessage[] = []
      const parser = new FrameParser((m) => out.push(m))
      const masked = encodeFrame(OPCODE.binary, payload, crypto.randomBytes(4))
      const plain = encodeFrame(OPCODE.binary, payload)
      // Fed in awkward pieces.
      for (const frame of [masked, plain]) for (let i = 0; i < frame.length; i += 7) parser.push(frame.subarray(i, i + 7))
      expect(out).toHaveLength(2)
      expect(out[0].payload.equals(payload)).toBe(true)
      expect(out[1].payload.equals(payload)).toBe(true)
    }
  })

  it("masks client frames", () => {
    const frame = encodeFrame(OPCODE.binary, Buffer.from("abcd"), Buffer.from([1, 2, 3, 4]))
    expect(frame[1] & 0x80).toBe(0x80)
    expect([...frame.subarray(6)]).toEqual([0x61 ^ 1, 0x62 ^ 2, 0x63 ^ 3, 0x64 ^ 4])
  })

  it("reassembles fragments with a control frame in between", () => {
    const out: WsMessage[] = []
    const parser = new FrameParser((m) => out.push(m))
    const first = encodeFrame(OPCODE.binary, Buffer.from("hel"))
    first[0] &= 0x7f // not FIN
    const ping = encodeFrame(OPCODE.ping, Buffer.from("p"))
    const last = encodeFrame(OPCODE.continuation, Buffer.from("lo"))
    parser.push(Buffer.concat([first, ping, last]))
    expect(out.map((m) => [m.opcode, m.payload.toString()])).toEqual([
      [OPCODE.ping, "p"],
      [OPCODE.binary, "hello"],
    ])
  })

  it("rejects protocol violations", () => {
    const parser = new FrameParser(() => {})
    expect(() => parser.push(encodeFrame(OPCODE.continuation, Buffer.from("x")))).toThrow(WebSocketProtocolError)
    const rsv = encodeFrame(OPCODE.text, Buffer.from("x"))
    rsv[0] |= 0x40
    expect(() => new FrameParser(() => {}).push(rsv)).toThrow(/reserved/)
  })

  it("computes the handshake accept value (RFC 6455 example)", () => {
    expect(acceptFor("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
  })
})

describe("exec channels", () => {
  it("prefixes the stream number", () => {
    expect([...channelMessage(CHANNEL.stdin, "ls\r")]).toEqual([0, 0x6c, 0x73, 0x0d])
    expect(JSON.parse(resizeMessage(120, 40).subarray(1).toString())).toEqual({ Width: 120, Height: 40 })
    expect(resizeMessage(1, 1)[0]).toBe(CHANNEL.resize)
    expect(parseChannelMessage(Buffer.from([1, 0x68, 0x69]))).toEqual({ channel: 1, data: Buffer.from("hi") })
    expect(parseChannelMessage(Buffer.alloc(0))).toBeNull()
  })

  it("reads the exit code from the status channel", () => {
    expect(exitCodeFromStatus('{"metadata":{},"status":"Success"}')).toEqual({ exitCode: 0 })
    expect(
      exitCodeFromStatus(
        JSON.stringify({
          status: "Failure",
          reason: "NonZeroExitCode",
          message: "command terminated with non-zero exit code: error executing command [sh -c exit 3], exit code 3",
          details: { causes: [{ reason: "ExitCode", message: "3" }] },
        })
      )
    ).toEqual({ exitCode: 3 })
    expect(exitCodeFromStatus('{"status":"Failure","message":"container not found"}')).toEqual({
      exitCode: null,
      message: "container not found",
    })
  })

  it("builds the exec request with the command repeated", () => {
    const req = execRequest("web", "api-1", "main", ["/bin/sh", "-c", "echo hi"])
    expect(req.path).toBe("/api/v1/namespaces/web/pods/api-1/exec")
    expect(req.query).toMatchObject({ container: "main", command: ["/bin/sh", "-c", "echo hi"], stdin: true, tty: true })
  })
})

/**
 * A fake API server that accepts the exec WebSocket and echoes stdin back on
 * stdout like a shell would, then reports an exit code. `protocols` is what
 * it is willing to speak.
 */
function fakeExecServer(protocols: string[]) {
  const seen: { url: string; auth?: string; protocol?: string; resizes: unknown[]; masked: boolean[] } = { url: "", resizes: [], masked: [] }
  const server = https.createServer({ cert: fx.server.cert, key: fx.server.key })
  server.on("upgrade", (req, socket: Duplex) => {
    seen.url = req.url ?? ""
    seen.auth = req.headers.authorization
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(/,\s*/)
    const protocol = offered.find((p) => protocols.includes(p))
    if (!req.url?.includes("/pods/api-1/") || !protocol) {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n" + JSON.stringify({ kind: "Status", message: 'pods "nope" not found', code: 404 }))
      return
    }
    seen.protocol = protocol
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptFor(String(req.headers["sec-websocket-key"]))}`,
        `Sec-WebSocket-Protocol: ${protocol}`,
        "",
        "",
      ].join("\r\n")
    )
    const send = (payload: Buffer) => socket.write(encodeFrame(OPCODE.binary, payload))
    const parser = new FrameParser((m) => {
      if (m.opcode === OPCODE.close) {
        socket.end()
        return
      }
      const msg = parseChannelMessage(m.payload)!
      if (msg.channel === CHANNEL.resize) seen.resizes.push(JSON.parse(msg.data.toString()))
      if (msg.channel === CHANNEL.stdin) {
        const text = msg.data.toString()
        if (text.startsWith("exit")) {
          send(channelMessage(CHANNEL.status, JSON.stringify({ status: "Failure", details: { causes: [{ reason: "ExitCode", message: "7" }] } })))
          socket.end()
        } else {
          send(channelMessage(CHANNEL.stdout, `you said: ${text}`))
        }
      }
    })
    socket.on("data", (chunk: Buffer) => {
      seen.masked.push((chunk[1] & 0x80) !== 0)
      parser.push(chunk)
    })
    socket.on("error", () => {})
  })
  return {
    seen,
    async start() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      return `https://127.0.0.1:${(server.address() as AddressInfo).port}`
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function readUntil(stream: ReadableStream<Uint8Array>, text: string) {
  const reader = stream.getReader()
  let out = ""
  while (!out.includes(text)) {
    const { done, value } = await reader.read()
    if (done) break
    out += Buffer.from(value).toString()
  }
  reader.releaseLock()
  return out
}

describe("pod exec over WebSocket (fake API server)", () => {
  it("negotiates v5, sends stdin and resizes, reads stdout and the exit code", async () => {
    const fake = fakeExecServer(["v5.channel.k8s.io", "v4.channel.k8s.io"])
    const server = await fake.start()
    try {
      const sid = await openPodExecSession({
        userId: 4242,
        target: { server, token: "tok", ca: fx.ca },
        namespace: "web",
        pod: "api-1",
        container: "main",
        command: ["/bin/sh"],
        cols: 80,
        rows: 24,
      })
      expect(fake.seen.protocol).toBe("v5.channel.k8s.io")
      expect(fake.seen.auth).toBe("Bearer tok")
      expect(fake.seen.url).toContain("command=%2Fbin%2Fsh")
      const abort = new AbortController()
      const out = openOutputStream(sid, 4242, abort.signal)
      writeInput(sid, 4242, "echo hi\r")
      expect(await readUntil(out, "you said: echo hi")).toContain("you said: echo hi")
      await resizeSession(sid, 4242, 120, 40)
      writeInput(sid, 4242, "exit\r")
      await expect(readUntil(out, "never")).resolves.toBeDefined() // stream ends when the process exits
      expect(fake.seen.resizes).toEqual([{ Width: 80, Height: 24 }, { Width: 120, Height: 40 }])
      expect(fake.seen.masked.every(Boolean)).toBe(true)
      expect(await closeSession(sid, 4242)).toEqual({ exitCode: 7 })
    } finally {
      await fake.close()
    }
  })

  it("falls back to v4 and reports API errors from the handshake", async () => {
    const fake = fakeExecServer(["v4.channel.k8s.io"])
    const server = await fake.start()
    try {
      const ok = await connectWebSocket({ server, token: "t", ca: fx.ca }, execRequest("web", "api-1", "main", ["sh"]), [
        "v5.channel.k8s.io",
        "v4.channel.k8s.io",
      ])
      expect(ok.protocol).toBe("v4.channel.k8s.io")
      ok.socket.destroy()
      await expect(
        connectWebSocket({ server, token: "t", ca: fx.ca }, execRequest("web", "nope", "main", ["sh"]), ["v4.channel.k8s.io"])
      ).rejects.toMatchObject({ status: 404, message: 'pods "nope" not found' })
      // The CA is checked like for every other call.
      await expect(
        connectWebSocket({ server, token: "t", ca: fx.rogueCa }, execRequest("web", "api-1", "main", ["sh"]), ["v4.channel.k8s.io"])
      ).rejects.toThrow(/TLS handshake/)
    } finally {
      await fake.close()
    }
  })
})

describe("console sessions", () => {
  it("belong to their user, buffer output until read and report the exit code", async () => {
    let written = ""
    let sink!: { data(chunk: Buffer): void; closed(): void }
    const sid = await registerSession(77, (s) => {
      sink = s
      s.data(Buffer.from("early "))
      return { write: (d) => void (written += d), resize: async () => {}, destroy: () => {}, exitCode: async () => 0 }
    })
    expect(() => writeInput(sid, 78, "x")).toThrow(ExecSessionError)
    writeInput(sid, 77, "ls")
    expect(written).toBe("ls")
    const out = openOutputStream(sid, 77, new AbortController().signal)
    sink.data(Buffer.from("late"))
    expect(await readUntil(out, "late")).toBe("early late")
    sink.closed()
    expect(() => writeInput(sid, 77, "x")).toThrow(/exited/)
    expect(await closeSession(sid, 77)).toEqual({ exitCode: 0 })
    expect(() => writeInput(sid, 77, "x")).toThrow(/not found/)
  })
})

// --------------------------------------------------------------------- Helm

const RECORD: HelmReleaseRecord = {
  name: "demo",
  namespace: "apps",
  version: 2,
  info: { status: "deployed", last_deployed: "2026-10-30T10:00:00Z", description: "Upgrade complete", notes: "Thanks!" },
  chart: { metadata: { name: "demo-chart", version: "1.2.3", appVersion: "4.5" } },
  config: { replicaCount: 2, auth: { password: "s3cret" } },
  manifest: `---
# Source: demo-chart/templates/cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: demo-config
---
# Source: demo-chart/templates/keep.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: demo-data
  annotations:
    helm.sh/resource-policy: keep
---
# Source: demo-chart/templates/deploy.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo
`,
}

function secretFor(record: HelmReleaseRecord, version = record.version, status = "deployed"): HelmReleaseSecret {
  return {
    secret: `sh.helm.release.v1.${record.name}.v${version}`,
    namespace: record.namespace,
    name: record.name,
    version,
    status,
    release: encodeRelease({ ...record, version }),
  }
}

function fakeApi(secrets: HelmReleaseSecret[], opts: { failDelete?: string } = {}) {
  const deleted: string[] = []
  const api = {
    async helmReleaseSecrets(ns: string | null, release?: string) {
      return secrets.filter((s) => (!ns || s.namespace === ns) && (!release || s.name === release))
    },
    discovery: () => async () => [],
    async deleteObject(o: { kind: string; name: string }, ns: string) {
      if (o.name === opts.failDelete) throw new KubeError("forbidden", 403)
      deleted.push(`${ns}/${o.kind}/${o.name}`)
      return true
    },
    async deleteSecret(ns: string, name: string) {
      deleted.push(`${ns}/Secret/${name}`)
    },
  }
  return { api: api as unknown as KubeApi, deleted }
}

describe("Helm releases", () => {
  it("decodes a release secret (base64 of base64 gzip JSON) and tolerates plain JSON", () => {
    expect(decodeRelease(secretFor(RECORD).release)).toMatchObject({ name: "demo", version: 2, config: { replicaCount: 2 } })
    const plain = Buffer.from(Buffer.from(JSON.stringify({ name: "old", version: 1 })).toString("base64")).toString("base64")
    expect(decodeRelease(plain)).toMatchObject({ name: "old" })
    expect(() => decodeRelease(Buffer.from(Buffer.from("not json").toString("base64")).toString("base64"))).toThrow(KubeError)
  })

  it("lists the latest revision of each release with display fields only", async () => {
    const other = { ...RECORD, name: "other", version: 1, chart: { metadata: { name: "x", version: "0.1.0" } } }
    const { api } = fakeApi([secretFor(RECORD, 1, "superseded"), secretFor(RECORD, 2), secretFor(other)])
    expect(latestRevisions(await api.helmReleaseSecrets(null)).map((s) => s.version)).toEqual([2, 1])
    const rows = await listReleases(api, null)
    expect(rows).toEqual([
      {
        id: "apps/demo",
        name: "demo",
        namespace: "apps",
        revision: 2,
        status: "deployed",
        chart: "demo-chart",
        chartVersion: "1.2.3",
        appVersion: "4.5",
        updated: "2026-10-30T10:00:00Z",
        description: "Upgrade complete",
      },
      expect.objectContaining({ name: "other", chart: "x", revision: 1 }),
    ])
    expect(JSON.stringify(rows)).not.toContain("s3cret")
  })

  it("shows values (as YAML), manifest, notes and the revision history", async () => {
    const { api } = fakeApi([secretFor(RECORD, 1, "superseded"), secretFor(RECORD, 2)])
    const detail = await getRelease(api, "apps", "demo")
    expect(detail?.values).toContain("replicaCount: 2")
    expect(detail?.manifest).toContain("kind: Deployment")
    expect(detail?.notes).toBe("Thanks!")
    expect(detail?.revisions).toEqual([2, 1])
    expect(await getRelease(api, "apps", "missing")).toBeNull()
  })

  it("uninstalls: objects in reverse order except kept ones, then every revision record", async () => {
    const { api, deleted } = fakeApi([secretFor(RECORD, 1, "superseded"), secretFor(RECORD, 2)])
    const res = await uninstallRelease(api, "apps", "demo")
    expect(res).toEqual({ deleted: 2, kept: ["PersistentVolumeClaim/demo-data"], failed: [] })
    expect(deleted).toEqual([
      "apps/Deployment/demo",
      "apps/ConfigMap/demo-config",
      "apps/Secret/sh.helm.release.v1.demo.v1",
      "apps/Secret/sh.helm.release.v1.demo.v2",
    ])
  })

  it("keeps the release records when an object can't be deleted", async () => {
    const { api, deleted } = fakeApi([secretFor(RECORD)], { failDelete: "demo-config" })
    const res = await uninstallRelease(api, "apps", "demo")
    expect(res.failed).toEqual(["ConfigMap/demo-config: forbidden"])
    expect(deleted.some((d) => d.includes("Secret"))).toBe(false)
    await expect(uninstallRelease(fakeApi([]).api, "apps", "demo")).rejects.toMatchObject({ status: 404 })
  })
})
