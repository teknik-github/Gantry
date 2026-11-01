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
import { containerName } from "@/lib/format"
import { getDb } from "@/lib/server/db"
import type { ContainerSummary, DockerApi } from "@/lib/server/docker/api"
import { docker } from "@/lib/server/docker/api"
import { environmentTarget, isDockerEnvironment } from "@/lib/server/environment-target"
import { skipIfBusy } from "@/lib/server/metrics-sampler"
import type { Environment } from "@/lib/server/db/schema"
import { notify } from "@/lib/server/notifications"
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

export type LocalImages = { byId: Map<string, LocalImage>; byTag: Map<string, LocalImage> }

const MAX_IMAGE_INSPECTS = 200

/**
 * The local images update statuses compare with: each container's image and
 * the image its tag points at now. Inspected one by one (fast) rather than
 * GET /images/json, which can take tens of seconds with the containerd image
 * store; and only for containers whose tag has been checked.
 */
export async function localImagesFor(
  api: Pick<DockerApi, "inspectImage">,
  environmentId: number,
  containers: Pick<ContainerSummary, "Id" | "ImageID">[],
  refs: Map<string, string>
): Promise<LocalImages> {
  const local: LocalImages = { byId: new Map(), byTag: new Map() }
  const known = cache.get(environmentId)
  if (!known?.size) return local
  const ids = new Set<string>()
  const tags = new Set<string>()
  for (const c of containers) {
    const ref = checkableReference(refs.get(c.Id) ?? "")
    if (!ref || !known.has(ref)) continue
    ids.add(c.ImageID)
    tags.add(ref)
  }
  const jobs = [...[...ids].map((id) => ({ id })), ...[...tags].map((tag) => ({ tag }))].slice(0, MAX_IMAGE_INSPECTS)
  await runBulk(
    jobs,
    async (job) => {
      const image = await api.inspectImage("id" in job ? job.id : job.tag)
      if ("id" in job) local.byId.set(job.id, image)
      else local.byTag.set(shortReference(job.tag), image)
    },
    { concurrency: 8 }
  )
  return local
}

/** Per-container update status from the last check (containers not checked yet are absent). */
export function containerUpdates(
  environmentId: number,
  containers: Pick<ContainerSummary, "Id" | "ImageID">[],
  /** From localImagesFor(). */
  local: LocalImages,
  /** From containerReferences(). */
  refs: Map<string, string>
): Map<string, ContainerUpdate> {
  const known = cache.get(environmentId)
  const out = new Map<string, ContainerUpdate>()
  if (!known) return out
  for (const c of containers) {
    const ref = checkableReference(refs.get(c.Id) ?? "")
    const remote = ref ? known.get(ref) : undefined
    if (!ref || !remote) continue
    const images = { tagged: local.byTag.get(shortReference(ref)) ?? null, running: local.byId.get(c.ImageID) ?? null }
    out.set(c.Id, {
      reference: ref,
      checkedAt: remote.checkedAt,
      remoteDigest: remote.digest ?? undefined,
      ...containerUpdateStatus(c.ImageID, images, remote),
    })
  }
  return out
}

/**
 * Update statuses for an environment's containers: references, the local
 * images to compare with, then the comparison.
 */
export async function updatesFor(
  api: Pick<DockerApi, "inspectContainer" | "inspectImage">,
  environmentId: number,
  containers: Pick<ContainerSummary, "Id" | "Image" | "ImageID">[],
  refs?: Map<string, string>
) {
  const references = refs ?? (await containerReferences(api, containers))
  const local = await localImagesFor(api, environmentId, containers, references)
  return { refs: references, updates: containerUpdates(environmentId, containers, local, references) }
}

/** When the environment was last checked (newest entry), or null. */
export function lastChecked(environmentId: number): number | null {
  const known = cache.get(environmentId)
  if (!known?.size) return null
  return Math.max(...[...known.values()].map((r) => r.checkedAt))
}

const lastErrors = new Map<number, string>()

// Updates already announced: container name + the digest it can update to.
const announced = new Set<string>()

/** Raises one "image_update" alert per environment for updates not announced before. */
async function announceUpdates(
  env: Pick<Environment, "id" | "name">,
  containers: Pick<ContainerSummary, "Id" | "Names">[],
  updates: Map<string, ContainerUpdate>
) {
  const fresh: string[] = []
  for (const c of containers) {
    const u = updates.get(c.Id)
    if (u?.status !== "update") continue
    const name = containerName(c)
    const key = `${env.id}|${name}|${u.remoteDigest ?? u.reference}`
    if (announced.has(key)) continue
    announced.add(key)
    fresh.push(`${name} (${u.reference})`)
  }
  if (announced.size > 10_000) announced.clear()
  if (!fresh.length) return
  await notify(
    {
      kind: "image_update",
      environment: env.name,
      subject: `${fresh.length} container${fresh.length === 1 ? "" : "s"} can be updated`,
      message: fresh.join("\n"),
    },
    env.id
  )
}

async function checkAllEnvironments(maxAgeMs: number) {
  const db = await getDb()
  // Docker environments only (Kubernetes ones have no images to check here).
  const envs = (await db.selectFrom("environments").selectAll().execute()).filter(isDockerEnvironment)
  for (const env of envs) {
    try {
      const api = docker(environmentTarget(env), { credentials: credentialsForImage })
      const containers = await api.listContainers(true)
      const refs = await containerReferences(api, containers)
      await checkReferences(env.id, api, referencesOf(refs), maxAgeMs)
      await announceUpdates(env, containers, (await updatesFor(api, env.id, containers, refs)).updates)
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
