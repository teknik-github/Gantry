import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DOCKER_EVENT_FILTERS, eventAffectsPath, toLiveEvent, type LiveEvent } from "@/lib/live"
import { createJsonLineParser } from "@/lib/server/docker/events"
import { EventHub, type HubMessage, type HubSource } from "@/lib/server/event-hub"

const raw = (Type: string, Action: string, attrs: Record<string, string> = {}, ID = "abc123def456") => ({
  Type,
  Action,
  Actor: { ID, Attributes: attrs },
  scope: "local",
  time: 1,
  timeNano: 1,
})

describe("docker event filter", () => {
  it.each([
    ["container", "start"],
    ["container", "die"],
    ["container", "destroy"],
    ["container", "rename"],
    ["image", "pull"],
    ["image", "untag"],
    ["volume", "create"],
    ["network", "connect"],
    ["network", "disconnect"],
  ])("keeps %s %s", (type, action) => {
    expect(toLiveEvent(raw(type, action))).toMatchObject({ type, action })
  })

  it.each([
    ["container", "exec_create: sh -c ls"],
    ["container", "exec_start: sh"],
    ["container", "exec_die"],
    ["container", "health_status: healthy"],
    ["container", "top"],
    ["container", "attach"],
    ["container", "resize"],
    ["volume", "mount"],
    ["volume", "unmount"],
    ["daemon", "reload"],
    ["plugin", "enable"],
  ])("drops %s %s", (type, action) => {
    expect(toLiveEvent(raw(type, action))).toBeNull()
  })

  it("rejects malformed input", () => {
    for (const value of [null, undefined, 42, "start", {}, { Type: "container" }, { Action: "start" }]) {
      expect(toLiveEvent(value)).toBeNull()
    }
  })

  it("passes on only the name and, for networks, the attached container", () => {
    expect(toLiveEvent(raw("container", "start", { name: "web", image: "nginx", "com.secret": "x" }))).toEqual({
      type: "container",
      action: "start",
      id: "abc123def456",
      name: "web",
    })
    expect(toLiveEvent(raw("network", "connect", { name: "bridge", container: "c0ffee" }, "net1"))).toEqual({
      type: "network",
      action: "connect",
      id: "net1",
      name: "bridge",
      container: "c0ffee",
    })
  })

  it("asks Docker to pre-filter by type and action", () => {
    expect(DOCKER_EVENT_FILTERS.type.sort()).toEqual(["container", "image", "network", "volume"])
    expect(DOCKER_EVENT_FILTERS.event).toContain("start")
    expect(DOCKER_EVENT_FILTERS.event).not.toContain("exec_start")
    expect(new Set(DOCKER_EVENT_FILTERS.event).size).toBe(DOCKER_EVENT_FILTERS.event.length)
  })
})

describe("which pages an event refreshes", () => {
  const start: LiveEvent = { type: "container", action: "start", id: "0123456789abcdef" }
  const pull: LiveEvent = { type: "image", action: "pull", id: "sha256:1" }

  it("refreshes the dashboard and unknown Docker pages for everything", () => {
    for (const path of ["/dashboard", "/stacks", "/topology"]) {
      expect(eventAffectsPath(start, path), path).toBe(true)
      expect(eventAffectsPath(pull, path), path).toBe(true)
    }
  })

  it("refreshes list pages only for what they show", () => {
    const create: LiveEvent = { type: "container", action: "create", id: "c1" }
    const volume: LiveEvent = { type: "volume", action: "create", id: "v1" }
    const connect: LiveEvent = { type: "network", action: "connect", id: "n1", container: "c1" }
    expect(eventAffectsPath(start, "/containers")).toBe(true)
    expect(eventAffectsPath(pull, "/containers")).toBe(false)
    expect(eventAffectsPath(pull, "/images")).toBe(true)
    expect(eventAffectsPath(create, "/images")).toBe(true)
    expect(eventAffectsPath(start, "/images")).toBe(false)
    expect(eventAffectsPath(volume, "/volumes")).toBe(true)
    expect(eventAffectsPath(start, "/volumes")).toBe(false)
    expect(eventAffectsPath(connect, "/networks")).toBe(true)
    expect(eventAffectsPath(volume, "/networks")).toBe(false)
  })

  it("leaves pages without Docker state alone", () => {
    for (const path of ["/users", "/account", "/activity", "/environments"]) {
      expect(eventAffectsPath(start, path), path).toBe(false)
    }
  })

  it("only refreshes a container page for that container", () => {
    expect(eventAffectsPath(start, "/containers/0123456789ab")).toBe(true)
    expect(eventAffectsPath(start, "/containers/0123456789abcdef")).toBe(true)
    expect(eventAffectsPath(start, "/containers/0123456789abffff")).toBe(false)
    expect(eventAffectsPath({ ...start, id: "fffff" }, "/containers/0123456789ab")).toBe(false)
    expect(eventAffectsPath(pull, "/containers/0123456789ab")).toBe(false)
    const connect: LiveEvent = { type: "network", action: "connect", id: "n", container: "0123456789abcdef" }
    expect(eventAffectsPath(connect, "/containers/0123456789ab")).toBe(true)
    expect(eventAffectsPath({ ...connect, container: undefined }, "/containers/0123456789ab")).toBe(false)
  })
})

describe("JSON line parser", () => {
  it("handles values split across chunks and skips garbage", () => {
    const seen: unknown[] = []
    const feed = createJsonLineParser((v) => seen.push(v))
    feed('{"a":1}\n{"b"')
    feed(':2}\nnot json\n\n{"c":')
    expect(seen).toEqual([{ a: 1 }, { b: 2 }])
    feed(Buffer.from("3}\n"))
    expect(seen).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
  })
})

/** A controllable stand-in for Docker's /events stream. */
function fakeSource() {
  type Conn = {
    open: () => void
    emit: (e: LiveEvent) => void
    end: () => void
    fail: (err?: Error) => void
    signal: AbortSignal
  }
  const connections: Conn[] = []
  const source: HubSource = ({ onOpen, onEvent }, signal) =>
    new Promise<void>((resolve, reject) => {
      connections.push({ open: onOpen, emit: onEvent, end: resolve, fail: (e) => reject(e ?? new Error("boom")), signal })
      signal.addEventListener("abort", () => resolve())
    })
  return { source, connections, live: () => connections.filter((c) => !c.signal.aborted) }
}

const event: LiveEvent = { type: "container", action: "start", id: "abc" }
const flush = () => vi.advanceTimersByTimeAsync(0)

describe("event hub", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("shares one upstream between subscribers and closes it when the last leaves", async () => {
    const hub = new EventHub({ lingerMs: 0 })
    const fake = fakeSource()
    const a: HubMessage[] = []
    const b: HubMessage[] = []

    const offA = hub.subscribe("env1", fake.source, (m) => a.push(m))
    const offB = hub.subscribe("env1", fake.source, (m) => b.push(m))
    expect(fake.connections).toHaveLength(1)
    expect(hub.listenerCount("env1")).toBe(2)
    expect(a[0]).toEqual({ kind: "status", status: "connecting" })

    fake.connections[0].open()
    fake.connections[0].emit(event)
    expect(a).toContainEqual({ kind: "status", status: "connected" })
    expect(a).toContainEqual({ kind: "event", event })
    expect(b).toContainEqual({ kind: "event", event })

    offA()
    offA() // idempotent
    expect(hub.listenerCount("env1")).toBe(1)
    expect(fake.connections[0].signal.aborted).toBe(false)
    offB()
    expect(fake.connections[0].signal.aborted).toBe(true)
    expect(hub.upstreamCount).toBe(0)
  })

  it("late subscribers get the current status immediately", async () => {
    const hub = new EventHub({ lingerMs: 0 })
    const fake = fakeSource()
    hub.subscribe("env1", fake.source, () => {})
    fake.connections[0].open()
    const late: HubMessage[] = []
    hub.subscribe("env1", fake.source, (m) => late.push(m))
    expect(late).toEqual([{ kind: "status", status: "connected" }])
  })

  it("keeps separate upstreams per environment", () => {
    const hub = new EventHub({ lingerMs: 0 })
    const one = fakeSource()
    const two = fakeSource()
    const got: string[] = []
    hub.subscribe("env1", one.source, (m) => m.kind === "event" && got.push("1"))
    hub.subscribe("env2", two.source, (m) => m.kind === "event" && got.push("2"))
    one.connections[0].open()
    two.connections[0].open()
    two.connections[0].emit(event)
    expect(got).toEqual(["2"])
    expect(hub.upstreamCount).toBe(2)
  })

  it("lingers briefly so a reload reuses the connection", async () => {
    const hub = new EventHub({ lingerMs: 5_000 })
    const fake = fakeSource()
    const off = hub.subscribe("env1", fake.source, () => {})
    off()
    await vi.advanceTimersByTimeAsync(4_000)
    hub.subscribe("env1", fake.source, () => {})
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fake.connections).toHaveLength(1)
    expect(fake.connections[0].signal.aborted).toBe(false)
  })

  it("reconnects with exponential backoff and resets it after a stable connection", async () => {
    const hub = new EventHub({ initialBackoffMs: 1_000, maxBackoffMs: 8_000, stableAfterMs: 10_000, lingerMs: 0 })
    const fake = fakeSource()
    const statuses: string[] = []
    hub.subscribe("env1", fake.source, (m) => m.kind === "status" && statuses.push(m.status))

    // Docker unreachable: 1s, 2s, 4s, 8s, 8s (capped).
    const delays = [1_000, 2_000, 4_000, 8_000, 8_000]
    for (const [i, delay] of delays.entries()) {
      fake.connections[i].fail()
      await flush()
      expect(statuses.at(-1)).toBe("reconnecting")
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(fake.connections).toHaveLength(i + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(fake.connections).toHaveLength(i + 2)
    }

    // Comes back and stays up: the next drop retries after the initial delay again.
    const conn = fake.connections.at(-1)!
    conn.open()
    expect(statuses.at(-1)).toBe("connected")
    await vi.advanceTimersByTimeAsync(15_000)
    conn.end()
    await flush()
    const before = fake.connections.length
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fake.connections).toHaveLength(before + 1)
  })

  it("does not reset the backoff for connections that drop right away", async () => {
    const hub = new EventHub({ initialBackoffMs: 1_000, maxBackoffMs: 60_000, stableAfterMs: 10_000, lingerMs: 0 })
    const fake = fakeSource()
    hub.subscribe("env1", fake.source, () => {})
    fake.connections[0].open()
    fake.connections[0].end()
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    fake.connections[1].open()
    fake.connections[1].end()
    await flush()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fake.connections).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.connections).toHaveLength(3)
  })

  it("stops retrying once nobody listens", async () => {
    const hub = new EventHub({ initialBackoffMs: 1_000, lingerMs: 0 })
    const fake = fakeSource()
    const off = hub.subscribe("env1", fake.source, () => {})
    fake.connections[0].fail()
    await flush()
    off()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.connections).toHaveLength(1)
    expect(hub.upstreamCount).toBe(0)
  })

  it("isolates a throwing subscriber and ignores events from a closed upstream", async () => {
    const hub = new EventHub({ lingerMs: 0 })
    const fake = fakeSource()
    const good: HubMessage[] = []
    hub.subscribe("env1", fake.source, (m) => {
      if (m.kind === "event") throw new Error("stream closed")
    })
    const off = hub.subscribe("env1", fake.source, (m) => good.push(m))
    fake.connections[0].open()
    fake.connections[0].emit(event)
    expect(good).toContainEqual({ kind: "event", event })

    off()
    const stale = fake.connections[0]
    // Re-subscribing after a full close opens a fresh upstream; the old one is ignored.
    const fresh: HubMessage[] = []
    hub.subscribe("env2", fake.source, (m) => fresh.push(m))
    stale.emit(event)
    expect(fresh.filter((m) => m.kind === "event")).toEqual([])
  })
})
