import "server-only"

import { startAlertWatcher } from "@/lib/server/alerts"
import { startAutoUpdateScheduler } from "@/lib/server/auto-update"
import { startBackupScheduler } from "@/lib/server/backup"
import { bootstrapFirstRun } from "@/lib/server/bootstrap"
import { startImageScanScheduler } from "@/lib/server/image-scans"
import { startHelperSweeper } from "@/lib/server/files/helper"
import { startUpdateChecker } from "@/lib/server/image-updates"
import { startMetricsSampler } from "@/lib/server/metrics-sampler"
import { startGitPoller } from "@/lib/server/stacks/git-sync"

/**
 * One-time server startup work (called from instrumentation.ts). Keep each
 * task independent and non-fatal so one failure can't stop the server.
 */
export async function runStartupTasks() {
  const tasks: [string, () => Promise<void>][] = [
    ["first-run setup", bootstrapFirstRun],
    ["metrics sampler", startMetricsSampler],
    ["image update checker", startUpdateChecker],
    ["alert watcher", startAlertWatcher],
    ["auto-update scheduler", startAutoUpdateScheduler],
    ["backup scheduler", startBackupScheduler],
    ["git stack poller", startGitPoller],
    ["image scan scheduler", startImageScanScheduler],
    ["file helper sweeper", startHelperSweeper],
  ]

  for (const [name, task] of tasks) {
    try {
      await task()
    } catch (err) {
      console.error(`[gantry] startup task "${name}" failed`, err)
    }
  }
}
