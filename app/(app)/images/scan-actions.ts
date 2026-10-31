"use server"

import { z } from "zod"

import { ALERT_SEVERITIES, SEVERITY_LABELS } from "@/lib/image-scan"
import { BULK_LIMIT, uniqueBy } from "@/lib/bulk"
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
  const parsed = targetsSchema.safeParse(targets)
  if (!parsed.success) return { error: "Invalid request" }
  const list = uniqueBy(parsed.data, (t) => t.id)
  const label = list.length === 1 ? list[0].name : `${list.length} images`

  return runAction(inEnvironment("operate", expectedEnvironment(environmentId)), "image.scan", label, async () => {
    const env = await getCurrentEnvironment()
    if (!env || env.type === "kubernetes") throw new UserError("Vulnerability scans need a Docker environment")
    try {
      const res = enqueueScans(
        env.id,
        list.map((t) => ({ imageId: t.id, reference: t.name }))
      )
      if (!res.queued) return list.length === 1 ? `${label} is already being scanned` : "These images are already queued"
      const later = res.ahead || res.queued > 1 ? " (one at a time)" : ""
      return `Scanning ${res.queued === 1 && list.length === 1 ? label : `${res.queued} image(s)`}${later}`
    } catch (err) {
      if (err instanceof ScanQueueError) throw new UserError(err.message)
      throw err
    }
  })
}

export async function saveScanSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
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
      error: "Please fix the highlighted fields",
      fieldErrors: {
        ...(fields.has("time") ? { time: ["Use HH:MM (24 h)"] } : {}),
        ...(fields.has("minSeverity") ? { minSeverity: ["Pick a severity"] } : {}),
      },
    }
  }
  const { time, enabled, minSeverity } = parsed.data
  return runAction("admin", "image-scan.settings", `${enabled ? `daily ${time}` : "off"}, alert ${minSeverity.toLowerCase()}`, async () => {
    await saveImageScanSettings({ enabled: enabled === "on", time, minSeverity })
    const alert = `alerts from ${SEVERITY_LABELS[minSeverity].toLowerCase()}${minSeverity === "CRITICAL" ? "" : " up"}`
    return enabled ? `Images in use are scanned daily at ${time}; ${alert}` : `Daily scan is off; ${alert}`
  })
}

/** Queues a scan of every image containers use, on every environment (like the daily run). */
export async function scanImagesInUseNow(): Promise<ActionState> {
  return runAction("admin", "image-scan.run", "images in use", async () => {
    const run = await scanImagesInUse("manual")
    if (run.errors.length) throw new UserError(`Queued ${run.queued} image(s); failed: ${run.errors.join("; ")}`)
    return run.queued ? `Queued ${run.queued} image(s) for scanning` : "Every image in use is already queued"
  })
}
