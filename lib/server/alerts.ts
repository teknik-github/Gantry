import "server-only"

import { ALERT_EVENT_FILTERS, ContainerAlertTracker, EnvironmentHealth } from "@/lib/alert-rules"
import { getDb } from "@/lib/server/db"
import type { Environment } from "@/lib/server/db/schema"
import { streamDockerEvents } from "@/lib/server/docker/events"
import { environmentTarget, isDockerEnvironment } from "@/lib/server/environment-target"
import { notify, pruneAlerts } from "@/lib/server/notifications"

/**
 * Background alert watcher: one Docker event stream per environment (kept
 * open, reconnected with backoff), fed to the alert rules. Also reports
 * environments that stay unreachable and prunes the alert history.
 */

const SYNC_EVERY_MS = 60_000
const PRUNE_EVERY_MS = 60 * 60_000
const MAX_BACKOFF_MS = 60_000

type Watch = { key: string; abort: AbortController }

const globalForAlerts = globalThis as unknown as {
  __gantryAlertWatcher?: { watches: Map<number, Watch>; timer: ReturnType<typeof setInterval> }
}

/** Changes to these columns restart an environment's stream. */
function watchKey(env: Environment) {
  return `${env.type}|${env.url}|${env.tls_cert?.slice(-16) ?? ""}|${env.name}`
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true })
  })

async function watchEnvironment(env: Environment, signal: AbortSignal) {
  const tracker = new ContainerAlertTracker()
  const health = new EnvironmentHealth()
  let backoff = 1_000
  while (!signal.aborted) {
    let openedAt = 0
    let error = ""
    try {
      await streamDockerEvents(
        environmentTarget(env),
        ALERT_EVENT_FILTERS,
        {
          onOpen: () => {
            openedAt = Date.now()
            if (health.connected() === "up") {
              void notify(
                { kind: "environment_down", environment: env.name, subject: `${env.name} is reachable again`, message: "" },
                env.id
              )
            }
          },
          onRaw: (raw) => {
            for (const draft of tracker.handle(raw)) void notify({ ...draft, environment: env.name }, env.id)
          },
        },
        signal
      )
    } catch (err) {
      error = (err as Error).message
    }
    if (signal.aborted) return
    // Reported once, after the environment stayed unreachable for the grace period.
    if (!openedAt && health.failing() === "down") {
      void notify(
        {
          kind: "environment_down",
          environment: env.name,
          subject: `${env.name} is unreachable`,
          message: `Gantry has not been able to reach Docker ${env.type === "agent" ? "through its agent" : `at ${env.url}`} for 2 minutes${error ? `: ${error}` : "."}`,
        },
        env.id
      )
    }
    // A connection that stayed up a while resets the backoff.
    backoff = openedAt && Date.now() - openedAt > 60_000 ? 1_000 : Math.min(backoff * 2, MAX_BACKOFF_MS)
    await sleep(backoff, signal)
  }
}

async function sync(watches: Map<number, Watch>) {
  const db = await getDb()
  const envs = (await db.selectFrom("environments").selectAll().execute()).filter(isDockerEnvironment)
  const seen = new Set<number>()
  for (const env of envs) {
    seen.add(env.id)
    const key = watchKey(env)
    const current = watches.get(env.id)
    if (current?.key === key) continue
    current?.abort.abort()
    const abort = new AbortController()
    watches.set(env.id, { key, abort })
    void watchEnvironment(env, abort.signal).catch((err) =>
      console.error(`[gantry] alert watcher for "${env.name}" stopped`, err)
    )
  }
  for (const [id, w] of watches) {
    if (!seen.has(id)) {
      w.abort.abort()
      watches.delete(id)
    }
  }
}

/** Starts the watcher once per process (environments are re-read every minute). */
export async function startAlertWatcher() {
  if (globalForAlerts.__gantryAlertWatcher) return
  const watches = new Map<number, Watch>()
  let lastPrune = 0
  const tick = async () => {
    try {
      await sync(watches)
      if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now()
        await pruneAlerts()
      }
    } catch (err) {
      console.error("[gantry] alert watcher sync failed", err)
    }
  }
  const timer = setInterval(() => void tick(), SYNC_EVERY_MS)
  timer.unref?.()
  globalForAlerts.__gantryAlertWatcher = { watches, timer }
  await tick()
}
