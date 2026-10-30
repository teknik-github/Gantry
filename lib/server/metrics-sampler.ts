import "server-only"

import { getDb } from "@/lib/server/db"
import type { Environment, NewMetric } from "@/lib/server/db/schema"
import { docker } from "@/lib/server/docker/api"
import { environmentTarget } from "@/lib/server/environment-target"
import { metricsConfig, retentionCutoff, sampleHost } from "@/lib/server/metrics"

/**
 * Background sampler behind the dashboard's history chart: every
 * METRICS_INTERVAL_SECONDS it records running containers, CPU and memory of
 * every environment, and hourly prunes rows older than METRICS_RETENTION_DAYS.
 */

const PRUNE_EVERY_MS = 60 * 60_000
const CONTAINER_CONCURRENCY = 8

type SamplerState = {
  interval: ReturnType<typeof setInterval>
  lastPrune: number
}

// Dev hot reloads re-run modules; the timer must only ever be started once.
const globalForSampler = globalThis as unknown as { __gantryMetricsSampler?: SamplerState }

/** Wraps an async task so a call made while the previous one is still running is skipped. */
export function skipIfBusy<T>(task: () => Promise<T>): () => Promise<T | undefined> {
  let busy = false
  return async () => {
    if (busy) return undefined
    busy = true
    try {
      return await task()
    } finally {
      busy = false
    }
  }
}

/** Rejects after `ms` (the underlying work may keep running until its own timeouts fire). */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

const lastErrors = new Map<number, string>()

async function sampleEnvironment(env: Environment, ts: string, budgetMs: number): Promise<NewMetric | null> {
  try {
    // Includes TLS material for tcp environments that require it.
    const api = docker(environmentTarget(env))
    const usage = await withTimeout(
      sampleHost(api, { concurrency: CONTAINER_CONCURRENCY }),
      budgetMs,
      `sampling took longer than ${Math.round(budgetMs / 1000)}s`
    )
    if (lastErrors.delete(env.id)) console.log(`[gantry] metrics: environment "${env.name}" reachable again`)
    return {
      environment_id: env.id,
      ts,
      containers: usage.running,
      cpu: usage.cpu,
      mem_used: usage.memory,
      mem_total: usage.memTotal,
    }
  } catch (err) {
    // Unreachable environments are skipped; log once per distinct error.
    const message = (err as Error).message
    if (lastErrors.get(env.id) !== message) {
      lastErrors.set(env.id, message)
      console.warn(`[gantry] metrics: skipping environment "${env.name}": ${message}`)
    }
    return null
  }
}

/** One sampling pass over all environments, in parallel so a slow one can't hold up the rest. */
export async function sampleAllEnvironments(state: { lastPrune: number }, now = Date.now()) {
  const { intervalMs, retentionDays } = metricsConfig()
  const db = await getDb()
  // Kubernetes environments have no Docker host to sample.
  const envs = await db.selectFrom("environments").selectAll().where("type", "!=", "kubernetes").execute()
  const ts = new Date(now).toISOString()
  // Leave headroom so a pass always ends before the next one is due.
  const budgetMs = Math.max(5_000, Math.min(intervalMs * 0.8, 50_000))

  const rows = (await Promise.all(envs.map((env) => sampleEnvironment(env, ts, budgetMs)))).filter(
    (r) => r !== null
  )
  if (rows.length) await db.insertInto("metrics").values(rows).execute()

  if (now - state.lastPrune >= PRUNE_EVERY_MS) {
    state.lastPrune = now
    await db.deleteFrom("metrics").where("ts", "<", retentionCutoff(now, retentionDays)).execute()
  }
}

/** Startup task (lib/server/startup.ts). Safe to call more than once. */
export async function startMetricsSampler() {
  // `next build` may load instrumentation while prerendering; only sample in a real server.
  if (process.env.NEXT_PHASE === "phase-production-build") return
  if (globalForSampler.__gantryMetricsSampler) return

  const { intervalMs } = metricsConfig()
  const state = { lastPrune: 0 } as SamplerState
  const tick = skipIfBusy(async () => {
    try {
      await sampleAllEnvironments(state)
    } catch (err) {
      console.error("[gantry] metrics sampling failed", err)
    }
  })

  state.interval = setInterval(() => void tick(), intervalMs)
  state.interval.unref()
  // First sample soon after boot rather than a full interval later.
  setTimeout(() => void tick(), Math.min(intervalMs, 5_000)).unref()
  globalForSampler.__gantryMetricsSampler = state
}
