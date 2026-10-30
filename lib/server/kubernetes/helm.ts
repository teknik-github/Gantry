import "server-only"

import zlib from "node:zlib"

import { stringify } from "yaml"

import { parseManifest } from "@/lib/kubernetes/manifest"
import type { HelmReleaseSecret, KubeApi } from "@/lib/server/kubernetes/api"
import { KubeError } from "@/lib/server/kubernetes/client"

/**
 * Helm 3 releases, read straight from the cluster: Helm stores every
 * revision as a Secret `sh.helm.release.v1.<name>.v<revision>` (type
 * helm.sh/release.v1, labels owner=helm, name, version, status) whose
 * `release` field is base64(gzip(JSON)) on top of the Secret's own base64.
 *
 * Reading the records needs no helm binary (the image has none) and uses
 * the environment's credentials like every other page. Only display
 * fields leave the server; values and manifests (which can contain
 * secrets) are shown to administrators only.
 */

const MAX_RELEASE_BYTES = 32 * 1024 * 1024

/** The parts of Helm's release JSON that Gantry reads. */
export type HelmReleaseRecord = {
  name: string
  namespace: string
  version: number
  info?: {
    status?: string
    first_deployed?: string
    last_deployed?: string
    description?: string
    notes?: string
  }
  chart?: { metadata?: { name?: string; version?: string; appVersion?: string; description?: string } }
  /** User-supplied values (`helm get values`). */
  config?: Record<string, unknown> | null
  manifest?: string
}

/** Decodes a release secret's `release` field (as returned by the API, still base64). */
export function decodeRelease(data: string): HelmReleaseRecord {
  let raw = Buffer.from(Buffer.from(data, "base64").toString("utf8"), "base64")
  // Helm gzips releases; very old records may be plain JSON.
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      raw = zlib.gunzipSync(raw, { maxOutputLength: MAX_RELEASE_BYTES })
    } catch {
      throw new KubeError("A Helm release record could not be decompressed", 502)
    }
  }
  try {
    return JSON.parse(raw.toString("utf8")) as HelmReleaseRecord
  } catch {
    throw new KubeError("A Helm release record is not valid JSON", 502)
  }
}

/** Encodes a release like Helm does (for tests and fixtures). */
export function encodeRelease(release: HelmReleaseRecord): string {
  const helm = zlib.gzipSync(Buffer.from(JSON.stringify(release))).toString("base64")
  return Buffer.from(helm).toString("base64")
}

export type HelmReleaseRow = {
  id: string
  name: string
  namespace: string
  revision: number
  status: string
  chart: string
  chartVersion: string
  appVersion: string
  updated: string
  description: string
}

export function toReleaseRow(record: HelmReleaseRecord, secret: Pick<HelmReleaseSecret, "namespace" | "status">): HelmReleaseRow {
  const meta = record.chart?.metadata ?? {}
  const namespace = record.namespace || secret.namespace
  return {
    id: `${namespace}/${record.name}`,
    name: record.name,
    namespace,
    revision: record.version,
    status: record.info?.status ?? secret.status,
    chart: meta.name ?? "",
    chartVersion: meta.version ?? "",
    appVersion: meta.appVersion ?? "",
    updated: record.info?.last_deployed ?? "",
    description: record.info?.description ?? "",
  }
}

/** The newest revision of each release. */
export function latestRevisions(secrets: HelmReleaseSecret[]): HelmReleaseSecret[] {
  const latest = new Map<string, HelmReleaseSecret>()
  for (const s of secrets) {
    const key = `${s.namespace}/${s.name}`
    const seen = latest.get(key)
    if (!seen || s.version > seen.version) latest.set(key, s)
  }
  return [...latest.values()]
}

/** Releases (latest revision each) in a namespace or all of them. Records that fail to decode are skipped. */
export async function listReleases(api: KubeApi, namespace: string | null): Promise<HelmReleaseRow[]> {
  const rows: HelmReleaseRow[] = []
  for (const secret of latestRevisions(await api.helmReleaseSecrets(namespace))) {
    try {
      rows.push(toReleaseRow(decodeRelease(secret.release), secret))
    } catch (err) {
      console.warn(`[gantry] helm release ${secret.namespace}/${secret.secret}: ${(err as Error).message}`)
    }
  }
  return rows.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
}

export type HelmReleaseDetail = HelmReleaseRow & {
  /** User-supplied values as YAML. */
  values: string
  manifest: string
  notes: string
  revisions: number[]
}

/** One release with its values and manifest. Callers must restrict this to administrators. */
export async function getRelease(api: KubeApi, namespace: string, name: string): Promise<HelmReleaseDetail | null> {
  const secrets = await api.helmReleaseSecrets(namespace, name)
  const [latest] = latestRevisions(secrets)
  if (!latest) return null
  const record = decodeRelease(latest.release)
  return {
    ...toReleaseRow(record, latest),
    values: record.config && Object.keys(record.config).length ? stringify(record.config) : "",
    manifest: record.manifest ?? "",
    notes: record.info?.notes ?? "",
    revisions: secrets.map((s) => s.version).sort((a, b) => b - a),
  }
}

export type UninstallResult = { deleted: number; kept: string[]; failed: string[] }

/**
 * Like `helm uninstall` without hooks: deletes the objects of the latest
 * revision's manifest (except those annotated helm.sh/resource-policy: keep),
 * then every revision record. Objects that fail are reported and the
 * records are left in place, so the release stays visible and can be retried.
 */
export async function uninstallRelease(api: KubeApi, namespace: string, name: string): Promise<UninstallResult> {
  const secrets = await api.helmReleaseSecrets(namespace, name)
  const [latest] = latestRevisions(secrets)
  if (!latest) throw new KubeError(`Helm release ${name} not found in ${namespace}`, 404)
  const record = decodeRelease(latest.release)

  const result: UninstallResult = { deleted: 0, kept: [], failed: [] }
  const manifest = record.manifest?.trim() ? parseManifest(record.manifest) : { ok: true as const, objects: [] }
  if (!manifest.ok) throw new KubeError(`The release manifest can't be read: ${manifest.error}`, 502)

  const resourcesOf = api.discovery()
  // Reverse order: dependents (Deployments) before what they use (ConfigMaps, ServiceAccounts).
  for (const o of [...manifest.objects].reverse()) {
    const label = `${o.kind}/${o.name}`
    const annotations = ((o.object.metadata as { annotations?: Record<string, string> } | undefined)?.annotations ?? {})
    if (annotations["helm.sh/resource-policy"] === "keep") {
      result.kept.push(label)
      continue
    }
    try {
      if (await api.deleteObject(o, namespace, resourcesOf)) result.deleted++
    } catch (err) {
      result.failed.push(`${label}: ${err instanceof KubeError ? err.message : "unexpected error"}`)
    }
  }
  if (result.failed.length) return result

  for (const s of secrets) {
    try {
      await api.deleteSecret(s.namespace, s.secret)
    } catch (err) {
      if (!(err instanceof KubeError && err.status === 404)) throw err
    }
  }
  return result
}
