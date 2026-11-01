import { describe, expect, it } from "vitest"

import * as agent from "@/agent/gantry-agent.mjs"
import {
  encodeData,
  encodeFrame,
  encodeJson,
  encodeReset,
  encodeWindow,
  FrameDecoder,
  FrameType,
  HEADER_BYTES,
  INITIAL_WINDOW,
  MAX_CONTROL,
  MAX_DATA,
  MAX_UPSTREAM_INFLIGHT,
  MAX_WINDOW,
  PROTOCOL_VERSION,
  ProtocolError,
  readWindow,
  ReceiveWindows,
  WINDOW_POOL,
} from "@/lib/agent/protocol"

describe("agent frame codec", () => {
  it("encodes type, stream id and length in a 9-byte header", () => {
    const f = encodeFrame(FrameType.DATA, 0x01020304, Buffer.from("hi"))
    expect([...f]).toEqual([FrameType.DATA, 1, 2, 3, 4, 0, 0, 0, 2, 0x68, 0x69])
    expect(HEADER_BYTES).toBe(9)
  })

  it("decodes frames split at every possible byte boundary", () => {
    const frames = [
      encodeFrame(FrameType.OPEN, 7),
      encodeFrame(FrameType.DATA, 7, Buffer.from("hello world")),
      encodeWindow(7, 123456),
      encodeFrame(FrameType.END, 7),
      encodeReset(9, "gone"),
    ]
    const wire = Buffer.concat(frames)
    for (let cut = 0; cut <= wire.length; cut++) {
      const d = new FrameDecoder()
      const out = [...d.push(wire.subarray(0, cut)), ...d.push(wire.subarray(cut))]
      expect(out.map((f) => [f.type, f.stream, f.payload.toString("hex")])).toEqual([
        [FrameType.OPEN, 7, ""],
        [FrameType.DATA, 7, Buffer.from("hello world").toString("hex")],
        [FrameType.WINDOW, 7, "0001e240"],
        [FrameType.END, 7, ""],
        [FrameType.RESET, 9, Buffer.from("gone").toString("hex")],
      ])
      expect(d.pending).toBe(0)
    }
  })

  it("decodes byte by byte and keeps an incomplete frame pending", () => {
    const wire = Buffer.concat([encodeJson(FrameType.HELLO, 0, { a: 1 }), encodeFrame(FrameType.DATA, 1, Buffer.alloc(10, 1))])
    const d = new FrameDecoder()
    const out = []
    for (let i = 0; i < wire.length - 1; i++) out.push(...d.push(wire.subarray(i, i + 1)))
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0].payload.toString())).toEqual({ a: 1 })
    expect(d.pending).toBe(HEADER_BYTES + 9)
    expect(d.push(wire.subarray(wire.length - 1))).toHaveLength(1)
  })

  it("splits data at MAX_DATA", () => {
    const frames = encodeData(3, Buffer.alloc(MAX_DATA * 2 + 5, 7))
    expect(frames.map((f) => f.length - HEADER_BYTES)).toEqual([MAX_DATA, MAX_DATA, 5])
    expect(encodeData(3, Buffer.alloc(0))).toEqual([])
  })

  it("caps frame sizes on both ends", () => {
    expect(() => encodeFrame(FrameType.DATA, 1, Buffer.alloc(MAX_DATA + 1))).toThrow(ProtocolError)
    expect(() => encodeFrame(FrameType.RESET, 1, Buffer.alloc(MAX_CONTROL + 1))).toThrow(ProtocolError)
    expect(encodeReset(1, "x".repeat(MAX_CONTROL * 2)).length).toBe(HEADER_BYTES + MAX_CONTROL)

    // An oversized length is refused from the header alone, before the payload is buffered.
    const header = Buffer.alloc(HEADER_BYTES)
    header.writeUInt8(FrameType.DATA, 0)
    header.writeUInt32BE(1, 1)
    header.writeUInt32BE(MAX_DATA + 1, 5)
    expect(() => new FrameDecoder().push(header)).toThrow(/too large/)
    const control = Buffer.from(header)
    control.writeUInt8(FrameType.PING, 0)
    control.writeUInt32BE(MAX_CONTROL + 1, 5)
    expect(() => new FrameDecoder().push(control)).toThrow(/too large/)
    // A 4 GB length can't make it allocate either.
    header.writeUInt32BE(0xffffffff, 5)
    expect(() => new FrameDecoder().push(header)).toThrow(/too large/)
  })

  it("refuses unknown frame types and bad stream ids", () => {
    const bad = Buffer.alloc(HEADER_BYTES)
    bad.writeUInt8(42, 0)
    expect(() => new FrameDecoder().push(bad)).toThrow(/Unknown frame type 42/)
    expect(() => encodeFrame(FrameType.OPEN, -1)).toThrow(ProtocolError)
    expect(() => encodeFrame(FrameType.OPEN, 2 ** 32)).toThrow(ProtocolError)
    expect(() => encodeFrame(FrameType.OPEN, 1.5)).toThrow(ProtocolError)
  })

  it("validates WINDOW increments", () => {
    expect(readWindow({ type: FrameType.WINDOW, stream: 1, payload: Buffer.from([0, 0, 1, 0]) })).toBe(256)
    expect(() => readWindow({ type: FrameType.WINDOW, stream: 1, payload: Buffer.from([0, 0, 0, 0]) })).toThrow(/positive/)
    expect(() => readWindow({ type: FrameType.WINDOW, stream: 1, payload: Buffer.from([1]) })).toThrow(/4-byte/)
  })
})

describe("the agent script's codec matches Gantry's", () => {
  it("uses the same constants", () => {
    expect(agent.PROTOCOL_VERSION).toBe(PROTOCOL_VERSION)
    expect(agent.FrameType).toEqual(FrameType)
    expect(agent.HEADER_BYTES).toBe(HEADER_BYTES)
    expect(agent.MAX_DATA).toBe(MAX_DATA)
    expect(agent.MAX_CONTROL).toBe(MAX_CONTROL)
  })

  it("encodes byte-identical frames", () => {
    const payloads = [Buffer.alloc(0), Buffer.from("x"), Buffer.alloc(MAX_DATA, 0xab)]
    for (const p of payloads) {
      expect(agent.encodeFrame(FrameType.DATA, 77, p).equals(encodeFrame(FrameType.DATA, 77, p))).toBe(true)
    }
    expect(() => agent.encodeFrame(FrameType.DATA, 1, Buffer.alloc(MAX_DATA + 1))).toThrow(/too large/)
  })

  it("decodes what Gantry encodes, in arbitrary chunks, and the other way round", () => {
    const wire = Buffer.concat([
      encodeJson(FrameType.HELLO, 0, { protocol: 1 }),
      ...encodeData(5, Buffer.alloc(200_000, 3)),
      encodeWindow(5, 1),
      encodeFrame(FrameType.GOAWAY, 0, Buffer.from("{}")),
    ])
    for (const step of [1, 7, 4096, 65_545, wire.length]) {
      const a = new agent.FrameDecoder()
      const g = new FrameDecoder()
      const fromAgent = []
      const fromGantry = []
      for (let i = 0; i < wire.length; i += step) {
        fromAgent.push(...a.push(wire.subarray(i, i + step)))
        fromGantry.push(...g.push(wire.subarray(i, i + step)))
      }
      expect(fromAgent.map((f: { type: number; stream: number; payload: Buffer }) => [f.type, f.stream, f.payload.length])).toEqual(
        fromGantry.map((f) => [f.type, f.stream, f.payload.length])
      )
      expect(fromAgent).toHaveLength(7)
    }
    const bad = Buffer.alloc(HEADER_BYTES)
    bad.writeUInt8(FrameType.DATA, 0)
    bad.writeUInt32BE(MAX_DATA + 1, 5)
    expect(() => new agent.FrameDecoder().push(bad)).toThrow(/too large/)
  })
})

describe("receive windows", () => {
  const MiB = 1024 * 1024
  type Impl = { open(): { window: number; outstanding: number; credit: number; sinceGrowth: number }; received(s: unknown, n: number): boolean; consumed(s: unknown, n: number): number; close(s: unknown): void; available: number }

  /** Runs the same script against Gantry's and the agent's implementation. */
  function script(w: Impl) {
    const log: unknown[] = []
    const a = w.open()
    const b = w.open()
    // A bulk stream whose consumer keeps up: every grant after a whole window grows it.
    for (let i = 0; i < 200; i++) {
      expect(w.received(a, MAX_DATA)).toBe(true)
      const g = w.consumed(a, MAX_DATA)
      if (g) log.push(["a", g, a.window, w.available])
    }
    // A stream whose consumer lags (a quarter window or more still unwritten) doesn't grow.
    for (let round = 0; round < 6; round++) {
      while (b.outstanding + MAX_DATA <= INITIAL_WINDOW) w.received(b, MAX_DATA)
      for (let i = 0; i < 12; i++) {
        const g = w.consumed(b, MAX_DATA)
        if (g) log.push(["b", g, b.window, w.available])
      }
    }
    log.push(["overrun", w.received(b, 10 * MiB)])
    w.close(a)
    w.close(a)
    log.push(["closed", w.available])
    return log
  }

  it("grow a busy stream up to the maximum, out of a shared pool, and give it back", () => {
    const g = new ReceiveWindows(INITIAL_WINDOW, MAX_WINDOW, 12 * MiB)
    const log = script(g as unknown as Impl)
    const grown = log.filter((e) => Array.isArray(e) && e[0] === "a").map((e) => (e as number[])[2])
    expect(grown[0]).toBe(INITIAL_WINDOW)
    expect(Math.max(...grown)).toBe(MAX_WINDOW)
    // Doubling: 1 -> 2 -> 4 -> 8 MiB, using 7 MiB of the pool.
    expect([...new Set(grown)]).toEqual([1, 2, 4, 8].map((x) => x * MiB))
    expect(log).toContainEqual(["overrun", false])
    expect(log.filter((e) => Array.isArray(e) && e[0] === "b").every((e) => (e as number[])[2] === INITIAL_WINDOW)).toBe(true)
    expect(log.at(-1)).toEqual(["closed", 12 * MiB])
  })

  it("stay fixed without growth, as before", () => {
    const w = new ReceiveWindows(INITIAL_WINDOW, INITIAL_WINDOW, WINDOW_POOL)
    const s = w.open()
    const grants: number[] = []
    for (let i = 0; i < 100; i++) {
      w.received(s, MAX_DATA)
      const g = w.consumed(s, MAX_DATA)
      if (g) grants.push(g)
    }
    expect(w.available).toBe(0)
    expect(s.window).toBe(INITIAL_WINDOW)
    expect(new Set(grants)).toEqual(new Set([INITIAL_WINDOW / 4]))
  })

  it("behave the same in the agent script", () => {
    expect(agent.MAX_UPSTREAM_INFLIGHT).toBe(MAX_UPSTREAM_INFLIGHT)
    for (const [max, pool] of [
      [MAX_WINDOW, 12 * MiB],
      [MAX_WINDOW, 2 * MiB],
      [INITIAL_WINDOW, WINDOW_POOL],
    ]) {
      expect(script(new agent.ReceiveWindows(INITIAL_WINDOW, max, pool) as Impl)).toEqual(
        script(new ReceiveWindows(INITIAL_WINDOW, max, pool) as unknown as Impl)
      )
    }
  })
})

describe("agent settings", () => {
  const key = `gak_3_${"A".repeat(43)}`

  it("requires the URL and a well-formed key", () => {
    expect(() => agent.loadConfig({})).toThrow(/GANTRY_URL is not set/)
    expect(() => agent.loadConfig({ GANTRY_URL: "https://g.example" })).toThrow(/GANTRY_AGENT_KEY is not set/)
    expect(() => agent.loadConfig({ GANTRY_URL: "https://g.example", GANTRY_AGENT_KEY: "gak_nope" })).toThrow(/malformed/)
    expect(() => agent.loadConfig({ GANTRY_URL: "ftp://g.example", GANTRY_AGENT_KEY: key })).toThrow(/https/)
    expect(() => agent.loadConfig({ GANTRY_URL: "https://u:p@g.example", GANTRY_AGENT_KEY: key })).toThrow(/credentials/)
  })

  it("refuses plain http to a remote Gantry unless told to", () => {
    expect(() => agent.loadConfig({ GANTRY_URL: "http://gantry.example:3000", GANTRY_AGENT_KEY: key })).toThrow(/Refusing plain http/)
    expect(agent.loadConfig({ GANTRY_URL: "http://gantry.example:3000", GANTRY_AGENT_KEY: key, GANTRY_AGENT_INSECURE: "1" }).insecure).toBe(true)
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(agent.loadConfig({ GANTRY_URL: `http://${host}:3000/`, GANTRY_AGENT_KEY: key }).base).toBe(`http://${host}:3000`)
    }
    const https = agent.loadConfig({ GANTRY_URL: "https://gantry.example/sub/", GANTRY_AGENT_KEY: key })
    expect(https).toMatchObject({ base: "https://gantry.example/sub", socket: "/var/run/docker.sock", ca: undefined })
  })

  it("takes a custom CA as PEM text", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----"
    expect(agent.loadConfig({ GANTRY_URL: "https://g.example", GANTRY_AGENT_KEY: key, GANTRY_AGENT_CA: pem }).ca).toBe(pem)
    expect(() => agent.loadConfig({ GANTRY_URL: "https://g.example", GANTRY_AGENT_KEY: key, GANTRY_AGENT_CA: "-----BEGIN nothing" })).toThrow(
      /no PEM certificate/
    )
  })

  it("backs off exponentially, and slowly when the key is refused", () => {
    expect(agent.backoffDelay(0)).toBeGreaterThanOrEqual(500)
    expect(agent.backoffDelay(0)).toBeLessThanOrEqual(1000)
    expect(agent.backoffDelay(20)).toBeLessThanOrEqual(30_000)
    expect(agent.backoffDelay(0, { status: 401 })).toBe(300_000)
    expect(agent.backoffDelay(0, { retry: false })).toBe(300_000)
    expect(agent.backoffDelay(0, { retryAfterMs: 42_000 })).toBe(42_000)
  })
})
