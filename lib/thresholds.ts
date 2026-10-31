import type { AlertDraft } from "@/lib/alert-rules"

// Resource alerts: a container (or a host) above a threshold for a while.
// Pure (time is injected); fed by the metrics sampler on every reading.

export type Thresholds = {
  /** Container CPU in % of one core (Docker's convention: 200% = two cores busy); null = off. */
  containerCpu: number | null
  /** Container memory in % of its limit (the host's memory when it has none); null = off. */
  containerMemory: number | null
  /** Memory used by an environment's containers in % of the host's memory; null = off. */
  hostMemory: number | null
  /** How long a value must stay above its threshold before an alert. */
  minutes: number
}

export const DEFAULT_THRESHOLDS: Thresholds = { containerCpu: null, containerMemory: null, hostMemory: null, minutes: 5 }

export type ResourceSample = {
  containers: { id: string; name: string; cpu: number; memory: number; memLimit: number }[]
  host: { memory: number; memTotal: number }
}

const COOLDOWN_MS = 60 * 60_000

export class ThresholdTracker {
  private since = new Map<string, number>()
  private lastAlert = new Map<string, number>()

  constructor(private now: () => number = Date.now) {}

  /** One reading of an environment; returns the alerts it raises. */
  sample(s: ResourceSample, t: Thresholds): AlertDraft[] {
    const now = this.now()
    const out: AlertDraft[] = []
    const seen = new Set<string>()
    const check = (key: string, above: boolean, draft: () => AlertDraft) => {
      seen.add(key)
      if (!above) {
        this.since.delete(key)
        return
      }
      const start = this.since.get(key) ?? now
      this.since.set(key, start)
      if (now - start < t.minutes * 60_000) return
      const last = this.lastAlert.get(key)
      if (last !== undefined && now - last < COOLDOWN_MS) return
      this.lastAlert.set(key, now)
      out.push(draft())
    }

    for (const c of s.containers) {
      if (t.containerCpu !== null) {
        check(`cpu:${c.id}`, c.cpu >= t.containerCpu, () => ({
          kind: "resource_high",
          subject: `${c.name} CPU at ${Math.round(c.cpu)}%`,
          message: `${c.name} has used at least ${t.containerCpu}% CPU (100% = one core) for ${t.minutes} minutes.`,
        }))
      }
      if (t.containerMemory !== null && c.memLimit > 0) {
        const pct = (c.memory / c.memLimit) * 100
        check(`mem:${c.id}`, pct >= t.containerMemory, () => ({
          kind: "resource_high",
          subject: `${c.name} memory at ${Math.round(pct)}%`,
          message: `${c.name} has used at least ${t.containerMemory}% of its memory limit for ${t.minutes} minutes (${formatMiB(c.memory)} of ${formatMiB(c.memLimit)}).`,
        }))
      }
    }
    if (t.hostMemory !== null && s.host.memTotal > 0) {
      const pct = (s.host.memory / s.host.memTotal) * 100
      check("host:memory", pct >= t.hostMemory, () => ({
        kind: "resource_high",
        subject: `Containers use ${Math.round(pct)}% of the host's memory`,
        message: `Running containers have used at least ${t.hostMemory}% of the host's memory for ${t.minutes} minutes (${formatMiB(s.host.memory)} of ${formatMiB(s.host.memTotal)}).`,
      }))
    }
    // Containers that went away start over if they come back.
    for (const key of this.since.keys()) if (!seen.has(key)) this.since.delete(key)
    if (this.lastAlert.size > 5_000) this.lastAlert.clear()
    return out
  }
}

function formatMiB(bytes: number) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`
}

/** Validates the thresholds form; empty fields turn a check off. */
export function checkThresholds(input: Record<string, string | undefined>): { thresholds?: Thresholds; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const pct = (key: string, max: number) => {
    const raw = (input[key] ?? "").trim()
    if (!raw) return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0 || n > max) {
      errors[key] = `1-${max}`
      return null
    }
    return n
  }
  const thresholds: Thresholds = {
    containerCpu: pct("containerCpu", 6400),
    containerMemory: pct("containerMemory", 100),
    hostMemory: pct("hostMemory", 100),
    minutes: Number(input.minutes ?? 5),
  }
  if (!Number.isInteger(thresholds.minutes) || thresholds.minutes < 1 || thresholds.minutes > 1440) errors.minutes = "1-1440"
  return Object.keys(errors).length ? { errors } : { thresholds, errors }
}
