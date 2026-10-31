"use server"

import { z } from "zod"

import { getI18n } from "@/lib/i18n/server"
import { expectedEnvironment, inEnvironment, runAction, UserError } from "@/lib/server/action"
import {
  AutoUpdateBusyError,
  runAutoUpdate,
  saveAutoUpdateSettings,
  setEnrolled,
} from "@/lib/server/auto-update"
import { getCurrentEnvironment } from "@/lib/server/environments"
import type { ActionState } from "@/lib/validation"

export async function saveSchedule(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = z
    .object({ time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, t.autoUpdate.errors.time), enabled: z.enum(["on"]).optional() })
    .safeParse({ time: formData.get("time"), enabled: formData.get("enabled") ?? undefined })
  if (!parsed.success) return { error: t.common.errors.fixFields, fieldErrors: { time: [t.autoUpdate.errors.time] } }
  const { time, enabled } = parsed.data
  return runAction("admin", "auto-update.schedule", enabled ? `daily ${time}` : "off", async () => {
    await saveAutoUpdateSettings({ enabled: enabled === "on", time })
    return enabled ? format(t.autoUpdate.runsDaily, { time }) : t.autoUpdate.scheduleOff
  })
}

/** Per-container opt-in in the current environment: managers of it may change it. */
export async function setContainerAutoUpdate(name: string, on: boolean, environmentId?: number): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).safeParse(name)
  if (!parsed.success) return { error: t.autoUpdate.errors.invalidName }
  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), on ? "auto-update.enable" : "auto-update.disable", parsed.data, async () => {
    const env = await getCurrentEnvironment()
    if (!env) throw new UserError(t.common.environment.noDockerConfigured)
    await setEnrolled(env.id, parsed.data, on === true)
    return format(on ? t.autoUpdate.enabled : t.autoUpdate.disabled, { name: parsed.data })
  })
}

/** Runs auto-update now on every environment (same as the scheduled run), so administrators only. */
export async function runAutoUpdateNow(): Promise<ActionState> {
  const { t, format } = await getI18n()
  return runAction("admin", "auto-update.run", "manual", async ({ user }) => {
    try {
      const run = await runAutoUpdate("manual", user)
      const count = (s: string) => run.results.filter((r) => r.status === s).length
      if (!run.results.length) return t.autoUpdate.noContainers
      const failed = count("failed")
      const summary = format(t.autoUpdate.summary, { updated: count("updated"), current: count("current"), skipped: count("skipped") })
      if (failed) throw new UserError(format(t.autoUpdate.errors.failed, { summary, failed }))
      return format(t.autoUpdate.finished, { summary })
    } catch (err) {
      if (err instanceof AutoUpdateBusyError) throw new UserError(t.autoUpdate.errors.busy)
      throw err
    }
  })
}
