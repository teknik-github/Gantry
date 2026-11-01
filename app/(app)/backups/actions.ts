"use server"

import { z } from "zod"

import { runAction, UserError } from "@/lib/server/action"
import { deleteStoredBackup, RestoreError, runStoredBackup, saveBackupSchedule } from "@/lib/server/backup"
import { MIN_PASSPHRASE } from "@/lib/server/backup-format"
import { getI18n } from "@/lib/i18n/server"
import type { ActionState } from "@/lib/validation"

const scheduleSchema = z.object({
  enabled: z.enum(["on"]).optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  keep: z.coerce.number().int().min(1).max(365),
  passphrase: z.string().max(1024),
})

export async function saveSchedule(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
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
      fieldErrors[key] ??= [key === "time" ? t.backups.schedule.timeFormat : key === "keep" ? "1-365" : issue.message]
    }
    return { error: t.common.errors.fixFields, fieldErrors }
  }
  const v = parsed.data
  if (v.passphrase && v.passphrase.length < MIN_PASSPHRASE) {
    return {
      error: t.common.errors.fixFields,
      fieldErrors: { passphrase: [format(t.backups.schedule.atLeast, { min: MIN_PASSPHRASE })] },
    }
  }
  return runAction("admin", "backup.schedule", v.enabled ? `daily ${v.time}, keep ${v.keep}` : "off", async () => {
    try {
      await saveBackupSchedule({ enabled: v.enabled === "on", time: v.time, keep: v.keep, passphrase: v.passphrase || undefined })
    } catch (err) {
      if (err instanceof RestoreError) throw new UserError(err.message)
      throw err
    }
    return v.enabled ? format(t.backups.schedule.savedOn, { time: v.time, keep: v.keep }) : t.backups.schedule.savedOff
  })
}

export async function backUpNow(): Promise<ActionState> {
  const { t, format, formatBytes } = await getI18n()
  return runAction("admin", "backup.run", "manual", async () => {
    try {
      const b = await runStoredBackup("manual")
      return format(t.backups.schedule.written, { name: b.name, size: formatBytes(b.size) })
    } catch (err) {
      if (err instanceof RestoreError) throw new UserError(err.message)
      throw err
    }
  })
}

export async function deleteBackup(name: string): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = z.string().max(100).safeParse(name)
  if (!parsed.success) return { error: t.backups.stored.invalid }
  return runAction("admin", "backup.delete", parsed.data, async () => {
    try {
      await deleteStoredBackup(parsed.data)
    } catch (err) {
      if (err instanceof RestoreError) throw new UserError(err.message)
      throw err
    }
    return t.backups.stored.deleted
  })
}
