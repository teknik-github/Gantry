"use server"

import { z } from "zod"

import { ALERT_SEVERITIES, SEVERITY_LABELS } from "@/lib/image-scan"
import { BULK_LIMIT, uniqueBy } from "@/lib/bulk"
import { getI18n } from "@/lib/i18n/server"
import { expectedEnvironment, inEnvironment, runAction, UserError } from "@/lib/server/action"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { enqueueScans, saveImageScanSettings, scanImagesInUse, ScanQueueError } from "@/lib/server/image-scans"
import type { ActionState } from "@/lib/validation"

const targetsSchema = z
  .array(
    z.object({
      id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      name: z.string().trim().min(1).max(255),
    })
  )
  .min(1)
  .max(BULK_LIMIT)

/**
 * Queues vulnerability scans of images in the current environment
 * (operators and up). Scans run in the background, one at a time per
 * environment; the Images page shows their progress.
 */
export async function scanImages(targets: { id: string; name: string }[], environmentId?: number): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = targetsSchema.safeParse(targets)
  if (!parsed.success) return { error: t.images.invalidRequest }
  const list = uniqueBy(parsed.data, (i) => i.id)
  const label = list.length === 1 ? list[0].name : `${list.length} images`

  return runAction(inEnvironment("operate", expectedEnvironment(environmentId)), "image.scan", label, async () => {
    const env = await getCurrentEnvironment()
    if (!env || env.type === "kubernetes") throw new UserError(t.images.scan.needsDocker)
    try {
      const res = enqueueScans(
        env.id,
        list.map((i) => ({ imageId: i.id, reference: i.name }))
      )
      if (!res.queued) return list.length === 1 ? format(t.images.scan.alreadyScanning, { name: label }) : t.images.scan.alreadyQueued
      const target = res.queued === 1 && list.length === 1 ? label : format(t.images.scan.imagesCount, { count: res.queued })
      return format(res.ahead || res.queued > 1 ? t.images.scan.scanningTargetOneAtATime : t.images.scan.scanningTarget, { target })
    } catch (err) {
      if (err instanceof ScanQueueError) throw new UserError(err.message)
      throw err
    }
  })
}

export async function saveScanSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = z
    .object({
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      enabled: z.enum(["on"]).optional(),
      minSeverity: z.enum(ALERT_SEVERITIES),
    })
    .safeParse({
      time: formData.get("time"),
      enabled: formData.get("enabled") ?? undefined,
      minSeverity: formData.get("minSeverity"),
    })
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((i) => String(i.path[0])))
    return {
      error: t.common.errors.fixFields,
      fieldErrors: {
        ...(fields.has("time") ? { time: [t.images.scan.invalidTime] } : {}),
        ...(fields.has("minSeverity") ? { minSeverity: [t.images.scan.pickSeverity] } : {}),
      },
    }
  }
  const { time, enabled, minSeverity } = parsed.data
  return runAction("admin", "image-scan.settings", `${enabled ? `daily ${time}` : "off"}, alert ${minSeverity.toLowerCase()}`, async () => {
    await saveImageScanSettings({ enabled: enabled === "on", time, minSeverity })
    const alert = format(minSeverity === "CRITICAL" ? t.images.scan.alertsFrom : t.images.scan.alertsFromUp, {
      severity: SEVERITY_LABELS[minSeverity].toLowerCase(),
    })
    return enabled ? format(t.images.scan.scheduleOn, { time, alert }) : format(t.images.scan.scheduleOff, { alert })
  })
}

/** Queues a scan of every image containers use, on every environment (like the daily run). */
export async function scanImagesInUseNow(): Promise<ActionState> {
  const { t, format } = await getI18n()
  return runAction("admin", "image-scan.run", "images in use", async () => {
    const run = await scanImagesInUse("manual")
    if (run.errors.length) throw new UserError(format(t.images.scan.queuedFailed, { count: run.queued, errors: run.errors.join("; ") }))
    return run.queued ? format(t.images.scan.queuedCount, { count: run.queued }) : t.images.scan.allQueued
  })
}
