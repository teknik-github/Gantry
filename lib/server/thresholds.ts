import "server-only"

import { DEFAULT_THRESHOLDS, ThresholdTracker, type Thresholds } from "@/lib/thresholds"
import type { HostUsage } from "@/lib/server/metrics"
import { notify } from "@/lib/server/notifications"
import { getSetting, setSetting } from "@/lib/server/settings"

// Resource alerts, evaluated on every metrics sample (lib/server/metrics-sampler.ts).

const KEY = "alerts.thresholds"

export async function getThresholds(): Promise<Thresholds> {
  const raw = await getSetting(KEY)
  try {
    return raw ? { ...DEFAULT_THRESHOLDS, ...(JSON.parse(raw) as Partial<Thresholds>) } : DEFAULT_THRESHOLDS
  } catch {
    return DEFAULT_THRESHOLDS
  }
}

export async function saveThresholds(t: Thresholds) {
  await setSetting(KEY, JSON.stringify(t))
}

const globalForThresholds = globalThis as unknown as { __gantryThresholds?: Map<number, ThresholdTracker> }
const trackers = (globalForThresholds.__gantryThresholds ??= new Map())

/** Checks one environment's reading against the thresholds and raises alerts. Never throws. */
export async function evaluateThresholds(env: { id: number; name: string }, usage: HostUsage) {
  try {
    const t = await getThresholds()
    if (t.containerCpu === null && t.containerMemory === null && t.hostMemory === null) return
    let tracker = trackers.get(env.id)
    if (!tracker) trackers.set(env.id, (tracker = new ThresholdTracker()))
    const drafts = tracker.sample({ containers: usage.containers, host: { memory: usage.memory, memTotal: usage.memTotal } }, t)
    for (const d of drafts) await notify({ ...d, environment: env.name }, env.id)
  } catch (err) {
    console.error("[gantry] threshold check failed", err)
  }
}
