import "server-only"

import { runBulk } from "@/lib/bulk"
import {
  checkableReference,
  containerUpdateStatus,
  isImageId,
  shortReference,
  type ContainerUpdate,
  type LocalImage,
} from "@/lib/image-updates"
import { getDb } from "@/lib/server/db"
import type { ContainerSummary, DockerApi, ImageSummary } from "@/lib/server/docker/api"
import { docker } from "@/lib/server/docker/api"
import { environmentTarget } from "@/lib/server/environment-target"
import { skipIfBusy } from "@/lib/server/metrics-sampler"
import { credentialsForImage } from "@/lib/server/registries"

/**
 * Image update checks: asks each environment's daemon which digest the
 * registry serves for the tags its containers use (GET /distribution, no
 * pull) and remembers the answers per environment, in memory. Checked on
 * demand ("Check for updates") and every UPDATE_CHECK_INTERVAL_HOURS.
 */

type RemoteDigest = { digest: string | null; error: string | null; checkedAt: number }

const globalForUpdates = globalThis as unknown as {
  __gantryImageUpdates?: Map<number, Map<string, RemoteDigest>>
  __gantryUpdateChecker?: ReturnType<typeof setInterval>
}
const cache = (globalForUpdates.__gantryImageUpdates ??= new Map())

const CONCURRENCY = 4
/** Registries rate-limit; one environment never asks about more tags than this per pass. */
const MAX_REFERENCES = 100

export function updateCheckIntervalMs() {
  const hours = Number(process.env.UPDATE_CHECK_INTERVAL_HOURS ?? 6)
  return Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 0
}

/** Containers whose reference is looked up with inspect, per call. */
const MAX_INSPECTS = 100

/**
 * The image reference each container was created from. The list shows an
 * image id instead once that tag points at a newer image (exactly the
 * containers that are out of date), so those are inspected for Config.Image.
 */
export async function containerReferences(
  api: Pick<DockerApi, "inspectContainer">,
  containers: Pick<ContainerSummary, "Id" | "Image">[]
): Promise<Map<string, string>> {
  const refs = new Map<string, string>()
  const unknown: string[] = []
  for (const c of containers) {
    if (isImageId(c.Image)) unknown.push(c.Id)
    else refs.set(c.Id, c.Image)
  }
  await runBulk(
    unknown.slice(0, MAX_INSPECTS),
    async (id) => {
      const image = (await api.inspectContainer(id)).Config.Image
      if (image) refs.set(id, image)
    },
    { concurrency: 8 }
  )
  return refs
}

/** Distinct checkable references among containers' references. */
export function referencesOf(refs: Map<string, string>) {
  const out = new Set<string>()
  for (const ref of refs.values()) {
    const checkable = checkableReference(ref)
    if (checkable) out.add(checkable)
  }
  return [...out].sort()
}

/**
 * Asks the registry about every reference not checked within `maxAgeMs`
 * (0 = all of them). Returns how many were checked and how many failed.
 */
export async function checkReferences(environmentId: number, api: DockerApi, refs: string[], maxAgeMs = 0) {
  const known = cache.get(environmentId) ?? new Map<string, RemoteDigest>()
  cache.set(environmentId, known)
  const now = Date.now()
  const due = refs.filter((r) => !maxAgeMs || now - (known.get(r)?.checkedAt ?? 0) >= maxAgeMs).slice(0, MAX_REFERENCES)

  const result = await runBulk(
    due,
    async (ref) => {
      const { Descriptor } = await api.distributionInspect(ref)
      known.set(ref, { digest: Descriptor.digest, error: null, checkedAt: Date.now() })
    },
    { concurrency: CONCURRENCY }
  )
  for (const { item, error } of result.failed) known.set(item, { digest: null, error, checkedAt: Date.now() })
  // Forget tags no container uses any more.
  for (const ref of known.keys()) if (!refs.includes(ref)) known.delete(ref)
  return { checked: due.length, failed: result.failed.length }
}

/** Per-container update status from the last check (containers not checked yet are absent). */
export function containerUpdates(
  environmentId: number,
  containers: Pick<ContainerSummary, "Id" | "ImageID">[],
  images: Pick<ImageSummary, "Id" | "RepoTags" | "RepoDigests">[],
  /** From containerReferences(). */
  refs: Map<string, string>
): Map<string, ContainerUpdate> {
  const known = cache.get(environmentId)
  const out = new Map<string, ContainerUpdate>()
  if (!known) return out
  const byId = new Map<string, LocalImage>(images.map((i) => [i.Id, i]))
  const byTag = new Map<string, LocalImage>()
  for (const i of images) for (const t of i.RepoTags ?? []) byTag.set(shortReference(t), i)
  for (const c of containers) {
    const ref = checkableReference(refs.get(c.Id) ?? "")
    const remote = ref ? known.get(ref) : undefined
    if (!ref || !remote) continue
    const local = { tagged: byTag.get(shortReference(ref)) ?? null, running: byId.get(c.ImageID) ?? null }
    out.set(c.Id, { reference: ref, checkedAt: remote.checkedAt, ...containerUpdateStatus(c.ImageID, local, remote) })
  }
  return out
}

/** When the environment was last checked (newest entry), or null. */
export function lastChecked(environmentId: number): number | null {
  const known = cache.get(environmentId)
  if (!known?.size) return null
  return Math.max(...[...known.values()].map((r) => r.checkedAt))
}

const lastErrors = new Map<number, string>()

async function checkAllEnvironments(maxAgeMs: number) {
  const db = await getDb()
  const envs = await db.selectFrom("environments").selectAll().execute()
  for (const env of envs) {
    try {
      const api = docker(environmentTarget(env), { credentials: credentialsForImage })
      const containers = await api.listContainers(true)
      await checkReferences(env.id, api, referencesOf(await containerReferences(api, containers)), maxAgeMs)
      lastErrors.delete(env.id)
    } catch (err) {
      const message = (err as Error).message
      if (lastErrors.get(env.id) !== message) {
        lastErrors.set(env.id, message)
        console.warn(`[gantry] update check: skipping environment "${env.name}": ${message}`)
      }
    }
  }
}

/** Starts the periodic check (once per process). UPDATE_CHECK_INTERVAL_HOURS=0 turns it off. */
export async function startUpdateChecker() {
  const interval = updateCheckIntervalMs()
  if (!interval || globalForUpdates.__gantryUpdateChecker) return
  // Half the interval, so tags checked on demand in between aren't asked about again.
  const tick = skipIfBusy(() => checkAllEnvironments(interval / 2))
  // First pass shortly after start, then every interval.
  setTimeout(() => void tick(), 2 * 60_000).unref?.()
  globalForUpdates.__gantryUpdateChecker = setInterval(() => void tick(), interval)
  globalForUpdates.__gantryUpdateChecker.unref?.()
  console.log(`[gantry] image update check every ${interval / 3_600_000} h`)
}
