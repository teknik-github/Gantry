import "server-only"

import { bootstrapFirstRun } from "@/lib/server/bootstrap"

/**
 * One-time server startup work (called from instrumentation.ts). Keep each
 * task independent and non-fatal so one failure can't stop the server.
 */
export async function runStartupTasks() {
  const tasks: [string, () => Promise<void>][] = [
    ["first-run setup", bootstrapFirstRun],
  ]

  for (const [name, task] of tasks) {
    try {
      await task()
    } catch (err) {
      console.error(`[gantry] startup task "${name}" failed`, err)
    }
  }
}
