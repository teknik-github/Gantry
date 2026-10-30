"use server"

import { z } from "zod"

import { runAction, UserError } from "@/lib/server/action"
import { deleteStoredBackup, RestoreError, runStoredBackup, saveBackupSchedule } from "@/lib/server/backup"
import { MIN_PASSPHRASE } from "@/lib/server/backup-format"
import { formatBytes } from "@/lib/format"
import type { ActionState } from "@/lib/validation"

const scheduleSchema = z.object({
  enabled: z.enum(["on"]).optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  keep: z.coerce.number().int().min(1).max(365),
  passphrase: z.string().max(1024),
})

export async function saveSchedule(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = scheduleSchema.safeParse({
    enabled: formData.get("enabled") ?? undefined,
    time: formData.get("time"),
    keep: formData.get("keep"),
    passphrase: formData.get("passphrase") ?? "",
  })
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {}
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0])
      fieldErrors[key] ??= [key === "time" ? "Use HH:MM (24 h)" : key === "keep" ? "1-365" : issue.message]
    }
    return { error: "Please fix the highlighted fields", fieldErrors }
  }
  const v = parsed.data
  if (v.passphrase && v.passphrase.length < MIN_PASSPHRASE) {
    return { error: "Please fix the highlighted fields", fieldErrors: { passphrase: [`At least ${MIN_PASSPHRASE} characters`] } }
  }
  return runAction("admin", "backup.schedule", v.enabled ? `daily ${v.time}, keep ${v.keep}` : "off", async () => {
    try {
      await saveBackupSchedule({ enabled: v.enabled === "on", time: v.time, keep: v.keep, passphrase: v.passphrase || undefined })
    } catch (err) {
      if (err instanceof RestoreError) throw new UserError(err.message)
      throw err
    }
    return v.enabled ? `Backups run daily at ${v.time} (keeping ${v.keep})` : "Scheduled backups are off"
  })
}

export async function backUpNow(): Promise<ActionState> {
  return runAction("admin", "backup.run", "manual", async () => {
    try {
      const b = await runStoredBackup("manual")
      return `Backup ${b.name} written (${formatBytes(b.size)})`
    } catch (err) {
      if (err instanceof RestoreError) throw new UserError(err.message)
      throw err
    }
  })
}

export async function deleteBackup(name: string): Promise<ActionState> {
  const parsed = z.string().max(100).safeParse(name)
  if (!parsed.success) return { error: "Invalid backup" }
  return runAction("admin", "backup.delete", parsed.data, async () => {
    try {
      await deleteStoredBackup(parsed.data)
    } catch (err) {
      if (err instanceof RestoreError) throw new UserError(err.message)
      throw err
    }
    return "Backup deleted"
  })
}
