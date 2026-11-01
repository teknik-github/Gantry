import "server-only"

import {
  emptyCounts,
  isAlertSeverity,
  newFindings,
  parseTrivyReport,
  ReportError,
  vulnerabilityAlert,
  type AlertSeverity,
  type Finding,
  type ScanSummary,
  type SeverityCounts,
} from "@/lib/image-scan"
import { isImageId } from "@/lib/image-updates"
import { scheduledRunDue } from "@/lib/server/auto-update"
import { getDb } from "@/lib/server/db"
import type { Environment, ImageScan } from "@/lib/server/db/schema"
import { docker } from "@/lib/server/docker/api"
import { DockerError } from "@/lib/server/docker/client"
import { environmentTarget, isDockerEnvironment } from "@/lib/server/environment-target"
import { containerReferences } from "@/lib/server/image-updates"
import { notify } from "@/lib/server/notifications"
import { credentialsForImage } from "@/lib/server/registries"
import { getSetting, setSetting } from "@/lib/server/settings"
import { INPUT_DIR, runTrivy, ScanError, sweepScanners } from "@/lib/server/trivy"

/**
 * Image vulnerability scans: a queue per environment (one Trivy run at a
 * time on each Docker host), the latest result per image in the database,
 * "vulnerability" alerts for findings the previous scan of the image didn't
 * have, and an optional daily scan of the images containers use.
 */

/** Most images waiting per environment. */
const MAX_QUEUE = 500
const SWEEP_INTERVAL_MS = 60 * 60_000

type Job = { imageId: string; reference: string }
type EnvironmentQueue = { running: (Job & { phase: string }) | null; waiting: Job[] }

type ScanState = {
  queues: Map<number, EnvironmentQueue>
  timer?: ReturnType<typeof setInterval>
  lastScheduledDay?: string
  lastSweep?: number
}
const globalForScans = globalThis as unknown as { __gantryImageScans?: ScanState }
const state: ScanState = (globalForScans.__gantryImageScans ??= { queues: new Map<number, EnvironmentQueue>() })

export class ScanQueueError extends Error {}

function queueOf(environmentId: number) {
  let q = state.queues.get(environmentId)
  if (!q) {
    q = { running: null, waiting: [] }
    state.queues.set(environmentId, q)
  }
  return q
}

/**
 * Adds images to the environment's scan queue (one scan runs at a time per
 * environment). Images already queued or being scanned are skipped.
 */
export function enqueueScans(environmentId: number, jobs: Job[]) {
  const q = queueOf(environmentId)
  const pending = new Set([...(q.running ? [q.running.imageId] : []), ...q.waiting.map((j) => j.imageId)])
  const fresh = jobs.filter((j) => !pending.has(j.imageId) && pending.add(j.imageId))
  if (q.waiting.length + fresh.length > MAX_QUEUE) {
    throw new ScanQueueError(`The scan queue of this environment is full (${MAX_QUEUE} images); try again when it has drained`)
  }
  q.waiting.push(...fresh)
  void work(environmentId)
  return { queued: fresh.length, skipped: jobs.length - fresh.length, ahead: q.running ? 1 : 0 }
}

/** Scans waiting or running in an environment, by image id. */
export function pendingScans(environmentId: number): Map<string, { pending: "queued" | "running"; phase: string | null }> {
  const q = state.queues.get(environmentId)
  const out = new Map<string, { pending: "queued" | "running"; phase: string | null }>()
  if (!q) return out
  if (q.running) out.set(q.running.imageId, { pending: "running", phase: q.running.phase })
  for (const j of q.waiting) if (!out.has(j.imageId)) out.set(j.imageId, { pending: "queued", phase: null })
  return out
}

async function work(environmentId: number) {
  const q = queueOf(environmentId)
  if (q.running) return
  while (q.waiting.length) {
    const job = q.waiting.shift()!
    q.running = { ...job, phase: "Starting" }
    try {
      await scanImage(environmentId, job, (phase) => {
        if (q.running) q.running.phase = phase
      })
    } catch (err) {
      console.error(`[gantry] scan of ${job.reference} failed`, err)
    } finally {
      q.running = null
    }
  }
}

function countsOf(row: Pick<ImageScan, "critical" | "high" | "medium" | "low" | "unknown">): SeverityCounts {
  return { CRITICAL: row.critical, HIGH: row.high, MEDIUM: row.medium, LOW: row.low, UNKNOWN: row.unknown }
}

function parseFindings(json: string): Finding[] {
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? (list as Finding[]) : []
  } catch {
    return []
  }
}

export async function getScanRow(environmentId: number, imageId: string) {
  const db = await getDb()
  return db
    .selectFrom("image_scans")
    .selectAll()
    .where("environment_id", "=", environmentId)
    .where("image_id", "=", imageId)
    .executeTakeFirst()
}

async function saveRow(environmentId: number, imageId: string, values: Omit<ImageScan, "id" | "environment_id" | "image_id">) {
  const db = await getDb()
  const updated = await db
    .updateTable("image_scans")
    .set(values)
    .where("environment_id", "=", environmentId)
    .where("image_id", "=", imageId)
    .executeTakeFirst()
  if (Number(updated.numUpdatedRows) === 0) {
    await db
      .insertInto("image_scans")
      .values({ ...values, environment_id: environmentId, image_id: imageId })
      .execute()
  }
}

/** Runs one scan now (the queue calls this) and stores the result; raises alerts for new findings. */
async function scanImage(environmentId: number, job: Job, phase: (text: string) => void) {
  const db = await getDb()
  const env = await db.selectFrom("environments").selectAll().where("id", "=", environmentId).executeTakeFirst()
  if (!env || env.type === "kubernetes") return
  const previous = await getScanRow(environmentId, job.imageId)
  const startedAt = Date.now()
  const attemptedAt = new Date().toISOString()
  const base = { reference: job.reference.slice(0, 512), attempted_at: attemptedAt }

  try {
    const target = environmentTarget(env)
    const api = docker(target, { credentials: credentialsForImage })
    // Also checks the image still exists before starting a scanner.
    const image = await api.inspectImage(job.imageId)
    const run = await runTrivy(target, job.imageId, { phase })
    const parsed = parseTrivyReport(run.report, { inputPath: INPUT_DIR })
    await saveRow(environmentId, job.imageId, {
      ...base,
      repo_digest: image.RepoDigests?.[0]?.slice(0, 512) ?? null,
      scanned_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      trivy_version: run.trivyVersion,
      db_version: run.dbVersion,
      os: parsed.os?.slice(0, 100) ?? null,
      critical: parsed.counts.CRITICAL,
      high: parsed.counts.HIGH,
      medium: parsed.counts.MEDIUM,
      low: parsed.counts.LOW,
      unknown: parsed.counts.UNKNOWN,
      findings: JSON.stringify(parsed.findings),
      truncated: parsed.truncated ? 1 : 0,
      error: null,
    })
    console.log(
      `[gantry] scanned ${job.reference} on ${env.name} in ${((Date.now() - startedAt) / 1000).toFixed(1)} s ` +
        `(pull ${run.timings.pull} ms, copy ${run.timings.copy} ms for ${Math.round(run.imageBytes / 1048576)} MB, trivy ${run.timings.scan} ms)`
    )

    const min = (await getImageScanSettings()).minSeverity
    const fresh = newFindings(
      previous?.scanned_at ? { findings: parseFindings(previous.findings), truncated: previous.truncated === 1 } : null,
      parsed.findings,
      min
    )
    if (fresh.length) await notify({ kind: "vulnerability", environment: env.name, ...vulnerabilityAlert(job.reference, fresh) }, env.id)
  } catch (err) {
    const message =
      err instanceof ScanError || err instanceof DockerError || err instanceof ReportError
        ? err.message
        : "Unexpected error; check the server logs"
    if (!(err instanceof ScanError || err instanceof DockerError || err instanceof ReportError)) {
      console.error(`[gantry] scan of ${job.reference} failed`, err)
    }
    await saveRow(environmentId, job.imageId, {
      ...base,
      repo_digest: previous?.repo_digest ?? null,
      scanned_at: previous?.scanned_at ?? null,
      duration_ms: previous?.duration_ms ?? null,
      trivy_version: previous?.trivy_version ?? null,
      db_version: previous?.db_version ?? null,
      os: previous?.os ?? null,
      critical: previous?.critical ?? 0,
      high: previous?.high ?? 0,
      medium: previous?.medium ?? 0,
      low: previous?.low ?? 0,
      unknown: previous?.unknown ?? 0,
      findings: previous?.findings ?? "[]",
      truncated: previous?.truncated ?? 0,
      error: message.slice(0, 1000),
    })
  }
}

/** Scan state of every scanned or pending image of an environment (no findings: cheap). */
export async function scanSummaries(environmentId: number): Promise<ScanSummary[]> {
  const db = await getDb()
  const rows = await db
    .selectFrom("image_scans")
    .select(["image_id", "reference", "scanned_at", "critical", "high", "medium", "low", "unknown", "error"])
    .where("environment_id", "=", environmentId)
    .execute()
  const pending = pendingScans(environmentId)
  const out: ScanSummary[] = rows.map((r) => ({
    imageId: r.image_id,
    reference: r.reference,
    scannedAt: r.scanned_at,
    counts: countsOf(r),
    error: r.error,
    pending: pending.get(r.image_id)?.pending ?? null,
    phase: pending.get(r.image_id)?.phase ?? null,
  }))
  const known = new Set(rows.map((r) => r.image_id))
  for (const [imageId, p] of pending) {
    if (!known.has(imageId)) {
      out.push({ imageId, reference: "", scannedAt: null, counts: emptyCounts(), error: null, ...p })
    }
  }
  return out
}

export type ImageScanDetails = ScanSummary & {
  repoDigest: string | null
  attemptedAt: string | null
  durationMs: number | null
  trivyVersion: string | null
  dbVersion: string | null
  os: string | null
  findings: Finding[]
  truncated: boolean
}

/** Everything about the latest scan of one image (findings included). */
export async function scanDetails(environmentId: number, imageId: string): Promise<ImageScanDetails | null> {
  const row = await getScanRow(environmentId, imageId)
  const p = pendingScans(environmentId).get(imageId)
  if (!row && !p) return null
  return {
    imageId,
    reference: row?.reference ?? "",
    scannedAt: row?.scanned_at ?? null,
    counts: row ? countsOf(row) : emptyCounts(),
    error: row?.error ?? null,
    pending: p?.pending ?? null,
    phase: p?.phase ?? null,
    repoDigest: row?.repo_digest ?? null,
    attemptedAt: row?.attempted_at ?? null,
    durationMs: row?.duration_ms ?? null,
    trivyVersion: row?.trivy_version ?? null,
    dbVersion: row?.db_version ?? null,
    os: row?.os ?? null,
    findings: row ? parseFindings(row.findings) : [],
    truncated: row?.truncated === 1,
  }
}

/**
 * Forgets scans of images that are gone from the environment (checked one
 * by one with inspect, which is fast, rather than listing every image).
 */
export async function pruneScans(env: Environment) {
  const db = await getDb()
  const rows = await db.selectFrom("image_scans").select("image_id").where("environment_id", "=", env.id).execute()
  const api = docker(environmentTarget(env))
  const gone: string[] = []
  for (const { image_id } of rows) {
    if (pendingScans(env.id).has(image_id)) continue
    try {
      await api.inspectImage(image_id)
    } catch (err) {
      if (err instanceof DockerError && err.status === 404) gone.push(image_id)
      else throw err
    }
  }
  for (let i = 0; i < gone.length; i += 100) {
    await db.deleteFrom("image_scans").where("environment_id", "=", env.id).where("image_id", "in", gone.slice(i, i + 100)).execute()
  }
  return gone.length
}

// Settings

const KEYS = {
  enabled: "image_scan.enabled",
  time: "image_scan.time",
  minSeverity: "image_scan.min_severity",
  lastRun: "image_scan.last_run",
}

export type ImageScanSettings = { enabled: boolean; time: string; minSeverity: AlertSeverity }
export type ImageScanRun = { trigger: "schedule" | "manual"; at: string; queued: number; errors: string[] }

export async function getImageScanSettings(): Promise<ImageScanSettings> {
  const [enabled, time, min] = await Promise.all([getSetting(KEYS.enabled), getSetting(KEYS.time), getSetting(KEYS.minSeverity)])
  return {
    enabled: enabled === "1",
    time: time && /^\d{2}:\d{2}$/.test(time) ? time : "04:00",
    minSeverity: isAlertSeverity(min) ? min : "CRITICAL",
  }
}

export async function saveImageScanSettings(s: ImageScanSettings) {
  await setSetting(KEYS.enabled, s.enabled ? "1" : "0")
  await setSetting(KEYS.time, s.time)
  await setSetting(KEYS.minSeverity, s.minSeverity)
}

export async function lastImageScanRun(): Promise<ImageScanRun | null> {
  const raw = await getSetting(KEYS.lastRun)
  try {
    return raw ? (JSON.parse(raw) as ImageScanRun) : null
  } catch {
    return null
  }
}

/** Distinct images the containers of an environment use, with a reference to show for each. */
export async function imagesInUse(env: Environment): Promise<Job[]> {
  const api = docker(environmentTarget(env), { credentials: credentialsForImage })
  const containers = await api.listContainers(true)
  const refs = await containerReferences(api, containers)
  const jobs = new Map<string, Job>()
  for (const c of containers) {
    if (jobs.has(c.ImageID)) continue
    const ref = refs.get(c.Id) ?? c.Image
    jobs.set(c.ImageID, { imageId: c.ImageID, reference: isImageId(ref) ? ref.replace(/^sha256:/, "").slice(0, 12) : ref })
  }
  return [...jobs.values()].filter((j) => /^sha256:[a-f0-9]{64}$/.test(j.imageId))
}

/** Queues a scan of every image in use on every Docker environment. */
export async function scanImagesInUse(trigger: ImageScanRun["trigger"]): Promise<ImageScanRun> {
  const db = await getDb()
  const envs = (await db.selectFrom("environments").selectAll().execute()).filter(isDockerEnvironment)
  let queued = 0
  const errors: string[] = []
  for (const env of envs) {
    try {
      queued += enqueueScans(env.id, await imagesInUse(env)).queued
    } catch (err) {
      errors.push(`${env.name}: ${(err as Error).message}`)
    }
  }
  const run: ImageScanRun = { trigger, at: new Date().toISOString(), queued, errors }
  await setSetting(KEYS.lastRun, JSON.stringify(run))
  return run
}

async function sweepAll() {
  const db = await getDb()
  const envs = (await db.selectFrom("environments").selectAll().execute()).filter(isDockerEnvironment)
  for (const env of envs) {
    try {
      const removed = await sweepScanners(environmentTarget(env))
      if (removed) console.log(`[gantry] removed ${removed} leftover scanner container(s) on ${env.name}`)
      await pruneScans(env)
    } catch {
      // Unreachable environments are reported elsewhere.
    }
  }
}

/**
 * Starts the daily scan check (every 30 s) and, at start and then hourly,
 * the sweep of leftover scanner containers and of scans of removed images.
 */
export async function startImageScanScheduler() {
  if (state.timer) return
  state.lastSweep = Date.now()
  void sweepAll()
  state.timer = setInterval(async () => {
    try {
      if (Date.now() - (state.lastSweep ?? 0) > SWEEP_INTERVAL_MS) {
        state.lastSweep = Date.now()
        await sweepAll()
      }
      const settings = await getImageScanSettings()
      const now = new Date()
      if (!settings.enabled || !scheduledRunDue(now, settings.time, state.lastScheduledDay)) return
      state.lastScheduledDay = now.toLocaleDateString("en-CA")
      const run = await scanImagesInUse("schedule")
      console.log(`[gantry] scheduled vulnerability scan: ${run.queued} image(s) queued`)
    } catch (err) {
      console.error("[gantry] scheduled vulnerability scan failed", err)
    }
  }, 30_000)
  state.timer.unref?.()
}
