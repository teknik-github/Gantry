import "server-only"

import crypto from "node:crypto"
import os from "node:os"

import type { DockerApi } from "@/lib/server/docker/api"
import { dockerJson, dockerRaw, DockerError, type DockerTarget } from "@/lib/server/docker/client"
import { config } from "@/lib/server/config"
import { filesConfig } from "@/lib/server/files/config"

/**
 * Short-lived helper containers that open a volume for the file browser:
 * the image from FILES_HELPER_IMAGE (alpine:3), no network, read-only root
 * filesystem, the volume mounted at VOLUME_MOUNT read-only, or read-write
 * for writes (separate helpers).
 *
 * Creating a container can take seconds (minutes on a loaded host), so a
 * helper is kept for FILES_HELPER_IDLE_SECONDS after its last operation and
 * reused by the next one on the same volume, then removed. Removal is
 * layered so none are left behind:
 * - after the idle time (and right away when the volume is removed in Gantry);
 * - helpers run `sleep` with AutoRemove: Docker deletes them when it ends
 *   (6 h) even if Gantry is gone;
 * - a sweep by label at startup (helpers of this Gantry instance: none can
 *   be in use yet) and every 10 minutes (any expired helper).
 */

export const HELPER_LABEL = "gantry.helper"
export const HELPER_KIND = "files"
export const VOLUME_MOUNT = "/gantry-volume"

const LIFETIME_SECONDS = 6 * 60 * 60
/** Don't start an operation on a helper that ends within this time. */
const MIN_REMAINING_MS = 60 * 60_000
const EXPIRES_LABEL = "gantry.helper.expires"
const INSTANCE_LABEL = "gantry.helper.instance"
const SWEEP_EVERY_MS = 10 * 60_000

/** Identifies this Gantry (host + data directory) so a restart can clean up after itself. */
export function instanceId() {
  return crypto.createHash("sha256").update(`${os.hostname()}\0${config.dataDir}`).digest("hex").slice(0, 16)
}

export type Helper = {
  id: string
  /** Hands the helper back (removed after the idle time); safe to call more than once. */
  release(): void
}

type Pooled = {
  key: string
  target: DockerTarget
  volume: string
  ready: Promise<string>
  /** Set once the helper runs. */
  id?: string
  users: number
  createdAt: number
  idleTimer: NodeJS.Timeout | null
  /** Gone or broken: never hand it out again. */
  retired: boolean
}

const globalForHelpers = globalThis as unknown as {
  __gantryFileHelpers?: Map<string, Pooled>
  __gantryHelperSweeper?: NodeJS.Timeout
}
const pool = (globalForHelpers.__gantryFileHelpers ??= new Map<string, Pooled>())

const targetKey = (t: DockerTarget) => `${t.type}:${t.url}`

async function ensureImage(api: DockerApi, image: string) {
  try {
    await api.inspectImage(image)
  } catch (err) {
    if (!(err instanceof DockerError) || err.status !== 404) throw err
    await api.pullImage(image)
  }
}

export async function removeHelper(target: DockerTarget, id: string) {
  try {
    await dockerRaw(target, "DELETE", `/containers/${encodeURIComponent(id)}`, {
      query: { force: true, v: false },
      timeoutMs: 120_000,
    })
  } catch (err) {
    // Already gone (AutoRemove) is fine; anything else is left for the sweeper.
    if (err instanceof DockerError && (err.status === 404 || /already in progress/i.test(err.message))) return
    console.error(`[gantry] could not remove file helper ${id.slice(0, 12)}`, err)
  }
}

async function createHelper(api: DockerApi, volume: string, write: boolean): Promise<string> {
  const { helperImage } = filesConfig()
  await ensureImage(api, helperImage)
  const name = `gantry-helper-files-${crypto.randomBytes(5).toString("hex")}`
  const { Id } = await api.createContainer(name, {
    Image: helperImage,
    Entrypoint: ["sleep"],
    Cmd: [String(LIFETIME_SECONDS)],
    Labels: {
      [HELPER_LABEL]: HELPER_KIND,
      [INSTANCE_LABEL]: instanceId(),
      "gantry.helper.volume": volume,
      "gantry.helper.access": write ? "rw" : "ro",
      // Grace for slow daemons: the sleep starts a little after creation.
      [EXPIRES_LABEL]: String(Date.now() + (LIFETIME_SECONDS + 10 * 60) * 1000),
    },
    NetworkDisabled: true,
    HostConfig: {
      Mounts: [
        {
          Type: "volume",
          Source: volume,
          Target: VOLUME_MOUNT,
          ReadOnly: !write,
          // Never copy image content into the volume.
          VolumeOptions: { NoCopy: true },
        },
      ],
      NetworkMode: "none",
      AutoRemove: true,
      ReadonlyRootfs: true,
      SecurityOpt: ["no-new-privileges"],
      Memory: 64 * 1024 * 1024,
      PidsLimit: 64,
      LogConfig: { Type: "none" },
    },
  })
  try {
    await api.containerAction(Id, "start")
  } catch (err) {
    await removeHelper(api.target, Id)
    throw err
  }
  return Id
}

function retire(entry: Pooled) {
  entry.retired = true
  if (pool.get(entry.key) === entry) pool.delete(entry.key)
  if (entry.idleTimer) clearTimeout(entry.idleTimer)
  entry.idleTimer = null
  if (entry.users === 0) void entry.ready.then((id) => removeHelper(entry.target, id), () => {})
}

/** A running helper with `volume` mounted (read-write only when `write`). Call release() when done. */
export async function acquireHelper(api: DockerApi, volume: string, opts: { write: boolean }): Promise<Helper> {
  const key = `${targetKey(api.target)}|${volume}|${opts.write ? "rw" : "ro"}`
  let entry = pool.get(key)
  if (entry && Date.now() - entry.createdAt > LIFETIME_SECONDS * 1000 - MIN_REMAINING_MS) {
    retire(entry)
    entry = undefined
  }
  if (!entry) {
    const created: Pooled = {
      key,
      target: api.target,
      volume,
      ready: createHelper(api, volume, opts.write),
      users: 0,
      createdAt: Date.now(),
      idleTimer: null,
      retired: false,
    }
    created.ready.then(
      (id) => (created.id = id),
      () => {}
    )
    created.ready.catch(() => {
      created.retired = true
      if (pool.get(key) === created) pool.delete(key)
    })
    pool.set(key, created)
    entry = created
  }
  const e = entry
  e.users++
  if (e.idleTimer) clearTimeout(e.idleTimer)
  e.idleTimer = null
  let id: string
  try {
    id = await e.ready
  } catch (err) {
    e.users--
    throw err
  }
  let released = false
  return {
    id,
    release() {
      if (released) return
      released = true
      e.users--
      if (e.users > 0) return
      if (e.retired) {
        void removeHelper(e.target, id)
        return
      }
      const idleMs = filesConfig().helperIdleMs
      e.idleTimer = setTimeout(() => {
        if (e.users === 0) retire(e)
      }, idleMs)
      e.idleTimer.unref?.()
    },
  }
}

/** The helper vanished or stopped (e.g. removed by someone): retire it so the next operation gets a new one. */
function isGone(err: unknown) {
  return err instanceof DockerError && (err.status === 404 || /is not running|no such container/i.test(err.message))
}

function retireById(id: string) {
  for (const entry of pool.values()) if (entry.id === id) retire(entry)
}

/** Runs `fn` with a helper (retrying once on a fresh one if the pooled helper is gone) and hands it back. */
export async function withHelper<T>(
  api: DockerApi,
  volume: string,
  opts: { write: boolean },
  fn: (helper: Helper) => Promise<T>
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const helper = await acquireHelper(api, volume, opts)
    try {
      return await fn(helper)
    } catch (err) {
      if (attempt === 0 && isGone(err)) {
        retireById(helper.id)
        continue
      }
      throw err
    } finally {
      helper.release()
    }
  }
}

/** Removes this process's idle helpers for a volume now (e.g. before removing the volume). */
export async function releaseVolumeHelpers(target: DockerTarget, volume: string) {
  const entries = [...pool.values()].filter((e) => e.volume === volume && targetKey(e.target) === targetKey(target))
  await Promise.all(
    entries.map(async (e) => {
      e.retired = true
      if (pool.get(e.key) === e) pool.delete(e.key)
      if (e.idleTimer) clearTimeout(e.idleTimer)
      if (e.users > 0) return
      const id = await e.ready.catch(() => null)
      if (id) await removeHelper(target, id)
    })
  )
}

type HelperSummary = { Id: string; Created: number; Labels: Record<string, string> }

/**
 * Removes stale helpers on one Docker host: expired ones (any Gantry), and
 * with `ownInstance` all of this instance's that aren't in this process's pool.
 */
export async function sweepHelpers(target: DockerTarget, opts: { ownInstance?: boolean; now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now()
  const helpers = await dockerJson<HelperSummary[]>(target, "GET", "/containers/json", {
    query: { all: true, filters: JSON.stringify({ label: [`${HELPER_LABEL}=${HELPER_KIND}`] }) },
    timeoutMs: 60_000,
  })
  // Pooled helpers (idle or busy) belong to this process and are removed by it.
  const inUse = new Set([...pool.values()].map((e) => e.id).filter(Boolean))
  const me = instanceId()
  let removed = 0
  for (const h of helpers) {
    if (inUse.has(h.Id)) continue
    const expires = Number(h.Labels?.[EXPIRES_LABEL])
    const staleAt = Number.isFinite(expires) && expires > 0 ? expires : h.Created * 1000 + (LIFETIME_SECONDS + 10 * 60) * 1000
    const mine = opts.ownInstance && h.Labels?.[INSTANCE_LABEL] === me
    if (now < staleAt && !mine) continue
    await removeHelper(target, h.Id)
    removed++
  }
  return removed
}

/** Startup task (lib/server/startup.ts): sweep every Docker environment now and periodically. */
export async function startHelperSweeper() {
  if (process.env.NEXT_PHASE === "phase-production-build") return
  if (globalForHelpers.__gantryHelperSweeper) return
  const pass = async (ownInstance: boolean) => {
    const [{ getDb }, { environmentTarget }] = await Promise.all([
      import("@/lib/server/db"),
      import("@/lib/server/environment-target"),
    ])
    const db = await getDb()
    const envs = await db.selectFrom("environments").selectAll().where("type", "!=", "kubernetes").execute()
    await Promise.all(
      envs.map(async (env) => {
        try {
          const removed = await sweepHelpers(environmentTarget(env), { ownInstance })
          if (removed) console.log(`[gantry] removed ${removed} stale file helper(s) in ${env.name}`)
        } catch {
          // Unreachable environment: try again next time.
        }
      })
    )
  }
  const timer = setInterval(() => void pass(false).catch(() => {}), SWEEP_EVERY_MS)
  timer.unref?.()
  globalForHelpers.__gantryHelperSweeper = timer
  // Don't hold up startup on slow or unreachable environments.
  void pass(true).catch((err) => console.error("[gantry] file helper sweep failed", err))
}
