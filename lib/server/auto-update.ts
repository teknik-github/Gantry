import "server-only"

import { SYSTEM_ACTOR, audit, type Actor } from "@/lib/server/audit"
import { getDb } from "@/lib/server/db"
import type { Environment } from "@/lib/server/db/schema"
import { docker, type ContainerSummary } from "@/lib/server/docker/api"
import { pullAndRecreate, RecreateError } from "@/lib/server/docker/recreate"
import { selfContainerIds } from "@/lib/server/docker/self"
import { environmentTarget, isDockerEnvironment } from "@/lib/server/environment-target"
import { checkReferences, containerReferences, referencesOf, updatesFor } from "@/lib/server/image-updates"
import { notify } from "@/lib/server/notifications"
import { credentialsForImage } from "@/lib/server/registries"
import { getSetting, setSetting } from "@/lib/server/settings"

/**
 * Scheduled updates (like Watchtower): once a day at a set time, containers
 * that opted in (by name from the UI, or with the label
 * `gantry.auto-update=true`) whose image tag has a newer image are pulled and
 * recreated with the same settings, one at a time, rolled back on failure.
 */

export const AUTO_UPDATE_LABEL = "gantry.auto-update"
const KEYS = { enabled: "auto_update.enabled", time: "auto_update.time", lastRun: "auto_update.last_run" }
/** A scheduled run still starts this long after its time (server busy, restarted…). */
const START_WINDOW_MS = 60 * 60_000

export type AutoUpdateSettings = { enabled: boolean; time: string }

export type AutoUpdateResult = {
  environment: string
  container: string
  image: string
  status: "updated" | "current" | "skipped" | "failed"
  message?: string
}

export type AutoUpdateRun = {
  trigger: "schedule" | "manual"
  startedAt: string
  finishedAt: string
  results: AutoUpdateResult[]
}

export async function getAutoUpdateSettings(): Promise<AutoUpdateSettings> {
  const [enabled, time] = await Promise.all([getSetting(KEYS.enabled), getSetting(KEYS.time)])
  return { enabled: enabled === "1", time: time && /^\d{2}:\d{2}$/.test(time) ? time : "03:00" }
}

export async function saveAutoUpdateSettings(s: AutoUpdateSettings) {
  await setSetting(KEYS.enabled, s.enabled ? "1" : "0")
  await setSetting(KEYS.time, s.time)
}

export async function lastAutoUpdateRun(): Promise<AutoUpdateRun | null> {
  const raw = await getSetting(KEYS.lastRun)
  try {
    return raw ? (JSON.parse(raw) as AutoUpdateRun) : null
  } catch {
    return null
  }
}

export async function enrolledNames(environmentId: number): Promise<Set<string>> {
  const db = await getDb()
  const rows = await db
    .selectFrom("auto_update_rules")
    .select("container_name")
    .where("environment_id", "=", environmentId)
    .execute()
  return new Set(rows.map((r) => r.container_name))
}

export async function setEnrolled(environmentId: number, name: string, on: boolean) {
  const db = await getDb()
  await db
    .deleteFrom("auto_update_rules")
    .where("environment_id", "=", environmentId)
    .where("container_name", "=", name)
    .execute()
  if (on) {
    await db
      .insertInto("auto_update_rules")
      .values({ environment_id: environmentId, container_name: name, created_at: new Date().toISOString() })
      .execute()
  }
}

export function containerNameOf(c: Pick<ContainerSummary, "Id" | "Names">) {
  return c.Names?.[0]?.replace(/^\//, "") || c.Id.slice(0, 12)
}

/** Why a container is enrolled: "rule" (chosen in Gantry), "label", or null. */
export function enrolment(c: Pick<ContainerSummary, "Id" | "Names" | "Labels">, names: Set<string>) {
  if (names.has(containerNameOf(c))) return "rule" as const
  if (c.Labels?.[AUTO_UPDATE_LABEL] === "true") return "label" as const
  return null
}

async function updateEnvironment(env: Environment, actor: Actor): Promise<AutoUpdateResult[]> {
  const api = docker(environmentTarget(env), { credentials: credentialsForImage })
  const names = await enrolledNames(env.id)
  const containers = (await api.listContainers(true)).filter((c) => enrolment(c, names) && c.State === "running")
  if (!containers.length) return []

  const refs = await containerReferences(api, containers)
  // Fresh answers from the registries for exactly these tags.
  await checkReferences(env.id, api, referencesOf(refs))
  const { updates } = await updatesFor(api, env.id, containers, refs)
  const self = selfContainerIds()

  const results: AutoUpdateResult[] = []
  // One at a time: each update stops and replaces a running container.
  for (const c of containers) {
    const base = { environment: env.name, container: containerNameOf(c), image: refs.get(c.Id) ?? c.Image }
    const u = updates.get(c.Id)
    if (!u || u.status === "unknown") {
      results.push({ ...base, status: "skipped", message: u?.reason ?? "Image tag can't be checked" })
      continue
    }
    if (u.status === "current") {
      results.push({ ...base, status: "current" })
      continue
    }
    try {
      const res = await pullAndRecreate(api, { id: c.Id, self })
      results.push({ ...base, status: res.updated ? "updated" : "current", message: res.updated ? res.warnings.join(". ") || undefined : undefined })
      if (res.updated) await audit(actor, "container.auto-update", base.container)
    } catch (err) {
      const message = err instanceof RecreateError || err instanceof Error ? err.message : String(err)
      results.push({ ...base, status: "failed", message })
      await audit(actor, "container.auto-update.failed", base.container)
    }
  }
  return results
}

const globalForAuto = globalThis as unknown as {
  __gantryAutoUpdate?: { running: boolean; timer?: ReturnType<typeof setInterval>; lastScheduledDay?: string }
}
const state = (globalForAuto.__gantryAutoUpdate ??= { running: false })

export class AutoUpdateBusyError extends Error {
  constructor() {
    super("An auto-update run is already in progress")
  }
}

/** Runs auto-update on every Docker environment; returns the run summary. */
export async function runAutoUpdate(trigger: AutoUpdateRun["trigger"], actor: Actor = SYSTEM_ACTOR("auto-update")) {
  if (state.running) throw new AutoUpdateBusyError()
  state.running = true
  const startedAt = new Date().toISOString()
  const results: AutoUpdateResult[] = []
  try {
    const db = await getDb()
    const envs = (await db.selectFrom("environments").selectAll().execute()).filter(isDockerEnvironment)
    for (const env of envs) {
      try {
        results.push(...(await updateEnvironment(env, actor)))
      } catch (err) {
        results.push({ environment: env.name, container: "—", image: "", status: "failed", message: (err as Error).message })
      }
    }
  } finally {
    state.running = false
  }
  const run: AutoUpdateRun = { trigger, startedAt, finishedAt: new Date().toISOString(), results }
  await setSetting(KEYS.lastRun, JSON.stringify(run))

  const updated = results.filter((r) => r.status === "updated")
  const failed = results.filter((r) => r.status === "failed")
  if (updated.length || failed.length) {
    const lines = [
      ...updated.map((r) => `✓ ${r.container} (${r.environment}): updated ${r.image}`),
      ...failed.map((r) => `✗ ${r.container} (${r.environment}): ${r.message ?? "failed"}`),
    ]
    await notify({
      kind: "auto_update",
      environment: [...new Set([...updated, ...failed].map((r) => r.environment))].join(", "),
      subject: `Auto-update: ${updated.length} updated${failed.length ? `, ${failed.length} failed` : ""}`,
      message: lines.join("\n"),
    })
  }
  return run
}

export function isAutoUpdateRunning() {
  return state.running
}

/** Local date (server time zone) as YYYY-MM-DD. */
function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** Whether a scheduled run is due at `now` (pure, for tests). */
export function scheduledRunDue(now: Date, time: string, lastScheduledDay: string | undefined) {
  const [h, m] = time.split(":").map(Number)
  const at = new Date(now)
  at.setHours(h, m, 0, 0)
  const since = now.getTime() - at.getTime()
  return since >= 0 && since < START_WINDOW_MS && lastScheduledDay !== localDay(now)
}

/** Checks every 30 s whether today's scheduled run is due. */
export async function startAutoUpdateScheduler() {
  if (state.timer) return
  state.timer = setInterval(async () => {
    try {
      const settings = await getAutoUpdateSettings()
      const now = new Date()
      if (!settings.enabled || state.running || !scheduledRunDue(now, settings.time, state.lastScheduledDay)) return
      state.lastScheduledDay = localDay(now)
      const run = await runAutoUpdate("schedule")
      console.log(`[gantry] auto-update: ${run.results.filter((r) => r.status === "updated").length} container(s) updated`)
    } catch (err) {
      console.error("[gantry] scheduled auto-update failed", err)
    }
  }, 30_000)
  state.timer.unref?.()
}
