"use server"

import { z } from "zod"

import { runAction, UserError } from "@/lib/server/action"
import {
  AutoUpdateBusyError,
  runAutoUpdate,
  saveAutoUpdateSettings,
  setEnrolled,
} from "@/lib/server/auto-update"
import { getCurrentEnvironment } from "@/lib/server/environments"
import type { ActionState } from "@/lib/validation"

export async function saveSchedule(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24 h)"), enabled: z.enum(["on"]).optional() })
    .safeParse({ time: formData.get("time"), enabled: formData.get("enabled") ?? undefined })
  if (!parsed.success) return { error: "Please fix the highlighted fields", fieldErrors: { time: ["Use HH:MM (24 h)"] } }
  const { time, enabled } = parsed.data
  return runAction("admin", "auto-update.schedule", enabled ? `daily ${time}` : "off", async () => {
    await saveAutoUpdateSettings({ enabled: enabled === "on", time })
    return enabled ? `Auto-update runs daily at ${time}` : "Scheduled auto-update is off"
  })
}

export async function setContainerAutoUpdate(name: string, on: boolean): Promise<ActionState> {
  const parsed = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).safeParse(name)
  if (!parsed.success) return { error: "Invalid container name" }
  return runAction("admin", on ? "auto-update.enable" : "auto-update.disable", parsed.data, async () => {
    const env = await getCurrentEnvironment()
    if (!env) throw new UserError("No Docker environment configured")
    await setEnrolled(env.id, parsed.data, on === true)
    return `${parsed.data}: auto-update ${on ? "on" : "off"}`
  })
}

/** Runs auto-update now on every environment (same as the scheduled run). */
export async function runAutoUpdateNow(): Promise<ActionState> {
  return runAction("admin", "auto-update.run", "manual", async ({ user }) => {
    try {
      const run = await runAutoUpdate("manual", user)
      const count = (s: string) => run.results.filter((r) => r.status === s).length
      if (!run.results.length) return "No running containers have auto-update on"
      const failed = count("failed")
      const summary = `${count("updated")} updated, ${count("current")} up to date, ${count("skipped")} skipped`
      if (failed) throw new UserError(`${summary}, ${failed} failed. See the results below.`)
      return `Auto-update finished: ${summary}`
    } catch (err) {
      if (err instanceof AutoUpdateBusyError) throw new UserError(err.message)
      throw err
    }
  })
}
