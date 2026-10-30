import { describe, expect, it } from "vitest"

import { ContainerAlertTracker, EnvironmentHealth } from "@/lib/alert-rules"
import { buildRequest, channelTarget, checkChannelConfig, type Alert } from "@/lib/notifications"
import { scheduledRunDue } from "@/lib/server/auto-update"

const ev = (Action: string, attrs: Record<string, string> = {}, id = "c1") => ({
  Type: "container",
  Action,
  Actor: { ID: id, Attributes: { name: "web", image: "nginx:1", ...attrs } },
})

function tracker() {
  let t = 0
  const tr = new ContainerAlertTracker({ now: () => t })
  return { tr, at: (ms: number) => (t = ms) }
}

describe("ContainerAlertTracker", () => {
  it("alerts on an unexpected non-zero exit, not on a requested stop or a clean exit", () => {
    const { tr, at } = tracker()
    expect(tr.handle(ev("die", { exitCode: "1" }))).toMatchObject([{ kind: "container_crash", subject: "web crashed (exit code 1)" }])

    // docker stop: kill → die(143) → stop
    at(20 * 60_000)
    expect(tr.handle(ev("kill", { signal: "15" }, "c2"))).toEqual([])
    expect(tr.handle(ev("die", { exitCode: "143" }, "c2"))).toEqual([])
    expect(tr.handle(ev("die", { exitCode: "0" }, "c3"))).toEqual([])
  })

  it("a stop asked long ago doesn't hide a later crash", () => {
    const { tr, at } = tracker()
    tr.handle(ev("stop"))
    at(5 * 60_000)
    expect(tr.handle(ev("die", { exitCode: "2" }))).toHaveLength(1)
  })

  it("applies a cooldown per container and kind, then reports a restart loop", () => {
    const { tr, at } = tracker()
    expect(tr.handle(ev("die", { exitCode: "1" }))).toHaveLength(1)
    at(60_000)
    expect(tr.handle(ev("die", { exitCode: "1" }))).toEqual([])
    at(120_000)
    expect(tr.handle(ev("die", { exitCode: "1" }))).toMatchObject([{ kind: "container_restart_loop", subject: "web keeps restarting" }])
    at(180_000)
    expect(tr.handle(ev("die", { exitCode: "1" }))).toEqual([])
  })

  it("reports OOM and unhealthy (not healthy) once per cooldown", () => {
    const { tr, at } = tracker()
    expect(tr.handle(ev("oom"))).toMatchObject([{ kind: "container_oom" }])
    expect(tr.handle(ev("health_status: healthy"))).toEqual([])
    expect(tr.handle(ev("health_status: unhealthy"))).toMatchObject([{ kind: "container_unhealthy", subject: "web is unhealthy" }])
    at(60_000)
    expect(tr.handle(ev("health_status: unhealthy"))).toEqual([])
    at(11 * 60_000)
    expect(tr.handle(ev("health_status: unhealthy"))).toHaveLength(1)
  })

  it("ignores other event types and malformed input", () => {
    const { tr } = tracker()
    expect(tr.handle({ Type: "network", Action: "die" })).toEqual([])
    expect(tr.handle(null)).toEqual([])
    expect(tr.handle({ Type: "container", Action: "die", Actor: {} })).toEqual([])
  })
})

describe("EnvironmentHealth", () => {
  it("reports down once after the grace period and up when it comes back", () => {
    let t = 0
    const h = new EnvironmentHealth(120_000, () => t)
    expect(h.failing()).toBeNull()
    t = 60_000
    expect(h.failing()).toBeNull()
    t = 130_000
    expect(h.failing()).toBe("down")
    t = 200_000
    expect(h.failing()).toBeNull()
    expect(h.connected()).toBe("up")
    expect(h.connected()).toBeNull()
  })
})

const alert: Alert = { kind: "container_crash", environment: "local", subject: "web crashed (exit code 1)", message: "Check its logs.", time: "2026-10-30T00:00:00.000Z" }

describe("channel requests", () => {
  it("telegram", () => {
    const req = buildRequest("telegram", { botToken: "123:ABC", chatId: "-100" }, alert)
    expect(req.url).toBe("https://api.telegram.org/bot123%3AABC/sendMessage")
    expect(JSON.parse(req.body)).toMatchObject({ chat_id: "-100", text: "[Gantry · local] web crashed (exit code 1)\nCheck its logs." })
  })

  it("discord, slack and webhook", () => {
    expect(JSON.parse(buildRequest("discord", { webhookUrl: "https://d/x" }, alert).body)).toMatchObject({
      content: expect.stringContaining("web crashed"),
      allowed_mentions: { parse: [] },
    })
    expect(JSON.parse(buildRequest("slack", { webhookUrl: "https://s/x" }, alert).body).text).toContain("web crashed")
    expect(JSON.parse(buildRequest("webhook", { url: "https://h/x" }, alert).body)).toEqual({ source: "gantry", ...alert })
  })

  it("ntfy uses plain text, ASCII headers and an optional token", () => {
    const req = buildRequest("ntfy", { server: "https://ntfy.sh/", topic: "ops", token: "tk" }, { ...alert, environment: "prod·1" })
    expect(req.url).toBe("https://ntfy.sh/ops")
    expect(req.body).toBe("Check its logs.")
    expect(req.headers).toMatchObject({ Title: "Gantry prod?1: web crashed (exit code 1)", Priority: "high", Authorization: "Bearer tk" })
  })

  it("describes targets without secrets", () => {
    expect(channelTarget("discord", { webhookUrl: "https://discord.com/api/webhooks/1/secret" })).toBe("discord.com")
    expect(channelTarget("telegram", { botToken: "secret", chatId: "42" })).toBe("chat 42")
  })
})

describe("checkChannelConfig", () => {
  it("validates required fields, URLs and formats", () => {
    expect(checkChannelConfig("discord", { webhookUrl: "ftp://x" }).errors).toEqual({ webhookUrl: "Use an http(s) URL" })
    expect(checkChannelConfig("telegram", { botToken: "", chatId: "abc" }).errors).toEqual({ botToken: "Required", chatId: "A numeric id or @channelname" })
    expect(checkChannelConfig("ntfy", { server: "https://ntfy.sh", topic: "a b" }).errors).toEqual({ topic: "Letters, digits, - and _ (max 64)" })
    expect(checkChannelConfig("ntfy", { server: "https://ntfy.sh", topic: "ops" })).toEqual({ config: { server: "https://ntfy.sh", topic: "ops" }, errors: {} })
  })

  it("keeps stored secrets when the field is left empty on edit", () => {
    const res = checkChannelConfig("telegram", { botToken: "", chatId: "7" }, { botToken: "stored", chatId: "1" })
    expect(res).toEqual({ config: { botToken: "stored", chatId: "7" }, errors: {} })
  })
})

describe("scheduledRunDue", () => {
  const at = (h: number, m: number) => {
    const d = new Date(2026, 9, 30, h, m)
    return d
  }
  it("is due from the set time for an hour, once a day", () => {
    expect(scheduledRunDue(at(2, 59), "03:00", undefined)).toBe(false)
    expect(scheduledRunDue(at(3, 0), "03:00", undefined)).toBe(true)
    expect(scheduledRunDue(at(3, 45), "03:00", undefined)).toBe(true)
    expect(scheduledRunDue(at(4, 1), "03:00", undefined)).toBe(false)
    expect(scheduledRunDue(at(3, 5), "03:00", "2026-10-30")).toBe(false)
    expect(scheduledRunDue(at(3, 5), "03:00", "2026-10-29")).toBe(true)
  })
})
