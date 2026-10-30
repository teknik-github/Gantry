import type { AlertKind } from "@/lib/notifications"

// Turns Docker container events into alerts. Pure (time is injected), so the
// rules are unit tested; lib/server/alerts.ts feeds it the live event stream.

/** Docker events the tracker needs (GET /events filters). */
export const ALERT_EVENT_FILTERS = {
  type: ["container"],
  event: ["kill", "stop", "die", "oom", "health_status", "destroy"],
}

export type AlertDraft = { kind: AlertKind; subject: string; message: string }

type RawEvent = {
  Type?: unknown
  Action?: unknown
  Actor?: { ID?: unknown; Attributes?: Record<string, unknown> | null } | null
}

export type TrackerOptions = {
  now?: () => number
  /** Same alert for the same container at most this often. */
  cooldownMs?: number
  /** A die within this long after kill/stop was asked for is intentional. */
  stopGraceMs?: number
  /** This many unexpected exits within the window is a restart loop. */
  loopCount?: number
  loopWindowMs?: number
}

export class ContainerAlertTracker {
  private now: () => number
  private cooldownMs: number
  private stopGraceMs: number
  private loopCount: number
  private loopWindowMs: number
  private stoppedAt = new Map<string, number>()
  private exits = new Map<string, number[]>()
  private lastAlert = new Map<string, number>()

  constructor(opts: TrackerOptions = {}) {
    this.now = opts.now ?? Date.now
    this.cooldownMs = opts.cooldownMs ?? 10 * 60_000
    this.stopGraceMs = opts.stopGraceMs ?? 60_000
    this.loopCount = opts.loopCount ?? 3
    this.loopWindowMs = opts.loopWindowMs ?? 10 * 60_000
  }

  /** Feeds one raw Docker event; returns the alerts it raises (usually none). */
  handle(raw: unknown): AlertDraft[] {
    const ev = raw as RawEvent
    if (!ev || ev.Type !== "container" || typeof ev.Action !== "string") return []
    const id = typeof ev.Actor?.ID === "string" ? ev.Actor.ID : ""
    if (!id) return []
    const attrs = ev.Actor?.Attributes ?? {}
    const name = typeof attrs.name === "string" ? attrs.name : id.slice(0, 12)
    const image = typeof attrs.image === "string" ? attrs.image : ""
    const action = ev.Action.split(":")[0].trim()
    const now = this.now()

    switch (action) {
      case "kill":
      case "stop":
        // docker stop/kill/restart, compose down, Gantry's recreate: all ask first.
        this.stoppedAt.set(id, now)
        return []
      case "destroy":
        this.stoppedAt.delete(id)
        this.exits.delete(id)
        return []
      case "oom":
        return this.raise(`oom:${id}`, {
          kind: "container_oom",
          subject: `${name} ran out of memory`,
          message: `The kernel OOM killer stopped a process in ${name}${image ? ` (${image})` : ""}. Consider a higher memory limit.`,
        })
      case "health_status": {
        const status = ev.Action.split(":")[1]?.trim()
        if (status !== "unhealthy") return []
        return this.raise(`unhealthy:${id}`, {
          kind: "container_unhealthy",
          subject: `${name} is unhealthy`,
          message: `The healthcheck of ${name}${image ? ` (${image})` : ""} is failing.`,
        })
      }
      case "die": {
        const asked = this.stoppedAt.get(id)
        if (asked !== undefined && now - asked <= this.stopGraceMs) return []
        const code = typeof attrs.exitCode === "string" ? attrs.exitCode : String(attrs.exitCode ?? "")
        const recent = (this.exits.get(id) ?? []).filter((t) => now - t <= this.loopWindowMs)
        recent.push(now)
        this.exits.set(id, recent)
        if (recent.length >= this.loopCount) {
          return this.raise(`loop:${id}`, {
            kind: "container_restart_loop",
            subject: `${name} keeps restarting`,
            message: `${name} exited ${recent.length} times in the last ${Math.round(this.loopWindowMs / 60_000)} minutes (last exit code ${code || "?"}).`,
          })
        }
        if (code === "0") return []
        return this.raise(`crash:${id}`, {
          kind: "container_crash",
          subject: `${name} crashed (exit code ${code || "?"})`,
          message: `${name}${image ? ` (${image})` : ""} stopped on its own with exit code ${code || "unknown"}. Check its logs.`,
        })
      }
      default:
        return []
    }
  }

  private raise(key: string, draft: AlertDraft): AlertDraft[] {
    const now = this.now()
    const last = this.lastAlert.get(key)
    if (last !== undefined && now - last < this.cooldownMs) return []
    this.lastAlert.set(key, now)
    // Keep the maps from growing forever on long-running servers.
    if (this.lastAlert.size > 5_000) this.lastAlert.clear()
    if (this.stoppedAt.size > 5_000) this.stoppedAt.clear()
    return [draft]
  }
}

/**
 * Tracks whether an environment's event stream is up and decides when to
 * report it down (after `graceMs` without a connection) and back up.
 */
export class EnvironmentHealth {
  private downSince: number | null = null
  private reported = false

  constructor(
    private graceMs = 2 * 60_000,
    private now: () => number = Date.now
  ) {}

  /** Connected: returns "up" when a down alert had been sent. */
  connected(): "up" | null {
    const wasReported = this.reported
    this.downSince = null
    this.reported = false
    return wasReported ? "up" : null
  }

  /** Disconnected or still failing: returns "down" once, after the grace period. */
  failing(): "down" | null {
    const now = this.now()
    this.downSince ??= now
    if (!this.reported && now - this.downSince >= this.graceMs) {
      this.reported = true
      return "down"
    }
    return null
  }
}
