import "server-only"

import { startMetricsSampler } from "@/lib/server/metrics-sampler"

/**
 * One-time server startup work (called from instrumentation.ts). Keep each
 * task independent and non-fatal so one failure can't stop the server.
 */
export async function runStartupTasks() {
  const tasks: [string, () => Promise<void>][] = [
    ["metrics sampler", startMetricsSampler],
  ]

  for (const [name, task] of tasks) {
    try {
      await task()
    } catch (err) {
      console.error(`[gantry] startup task "${name}" failed`, err)
    }
  }
}
