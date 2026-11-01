import "server-only"

import { JsonLineParser } from "@/lib/image-build"
import { registryAuthHeader } from "@/lib/registry"
import { splitImageRef } from "@/lib/server/docker/api"
import {
  connectionError,
  demuxLogs,
  dockerErrorMessage,
  dockerJson,
  dockerRaw,
  dockerRequest,
  DockerError,
  type DockerTarget,
} from "@/lib/server/docker/client"
import { dockerStream } from "@/lib/server/docker/stream"
import { credentialsForImage } from "@/lib/server/registries"
import { directoryTar } from "@/lib/server/tar"

/**
 * Runs Trivy (https://trivy.dev) as a short-lived container on the Docker
 * environment that holds the image, through the Docker API only:
 *
 * 1. the scanner container is created (not started) with the vulnerability
 *    database cache on a named volume of that environment;
 * 2. the image is exported with GET /images/{id}/get (`docker save`) and
 *    streamed straight into the container with PUT /archive, which unpacks
 *    it into /scan/image: an OCI image layout Trivy reads with --input.
 *    Nothing is buffered in Gantry, and nothing needs the Docker socket
 *    inside the scanner, so remote TCP/TLS environments work the same;
 * 3. the container runs `trivy image --input`, the JSON report and the
 *    database metadata are read back with GET /archive;
 * 4. the container is always removed (startup and hourly sweeps catch
 *    leftovers by label).
 */

/** Pinned scanner image; TRIVY_IMAGE overrides it. */
export const DEFAULT_TRIVY_IMAGE = "aquasec/trivy:0.76.1"
export const SCANNER_LABEL = "gantry.scanner"
const CACHE_DIR = "/root/.cache/trivy"
export const INPUT_DIR = "/scan/image"
const REPORT = "/scan/report.json"

/** Trivy settings passed on to the scanner container when set for Gantry. */
const FORWARDED_ENV = [
  "TRIVY_DB_REPOSITORY",
  "TRIVY_JAVA_DB_REPOSITORY",
  "TRIVY_SKIP_DB_UPDATE",
  "TRIVY_SKIP_JAVA_DB_UPDATE",
  "TRIVY_OFFLINE_SCAN",
  "TRIVY_INSECURE",
] as const

export function trivyImage() {
  return process.env.TRIVY_IMAGE?.trim() || DEFAULT_TRIVY_IMAGE
}

export function trivyCacheVolume() {
  const name = process.env.TRIVY_CACHE_VOLUME?.trim()
  return name && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) ? name : "gantry-trivy-cache"
}

/** Longest a whole scan (pull, copy, scan) may take; TRIVY_TIMEOUT_MINUTES, default 20. */
export function scanTimeoutMs() {
  const minutes = Number(process.env.TRIVY_TIMEOUT_MINUTES ?? 20)
  return (Number.isFinite(minutes) && minutes >= 1 ? Math.min(minutes, 240) : 20) * 60_000
}

export class ScanError extends Error {}

export type TrivyRun = {
  /** Parsed JSON report. */
  report: unknown
  trivyVersion: string | null
  /** UpdatedAt of the vulnerability database used. */
  dbVersion: string | null
  /** Bytes of the exported image. */
  imageBytes: number
  timings: Record<"pull" | "copy" | "scan", number>
}

type Phase = (text: string) => void

const enc = encodeURIComponent

/** Id, as Docker returns it, of the image or container a path segment names. */
function idSeg(value: string) {
  if (!/^(sha256:)?[a-f0-9]{12,64}$/.test(value)) throw new DockerError("Invalid identifier", 400)
  return enc(value)
}

/** Pulls `reference` unless present, reporting progress. */
export async function ensureScannerImage(target: DockerTarget, reference: string, phase: Phase = () => {}) {
  try {
    const image = await dockerJson<{ Config?: { Labels?: Record<string, string> | null } | null }>(
      target,
      "GET",
      `/images/${reference.split("/").map(enc).join("/")}/json`,
      { timeoutMs: 30_000 }
    )
    return image.Config?.Labels?.["org.opencontainers.image.version"] ?? null
  } catch (err) {
    if (!(err instanceof DockerError) || err.status !== 404) throw err
  }

  phase("Pulling scanner image")
  const { image, tag } = splitImageRef(reference)
  const cred = await credentialsForImage(reference)
  const res = await dockerStream(target, "POST", "/images/create", {
    query: { fromImage: image, tag: tag || undefined },
    headers: cred ? { "X-Registry-Auth": registryAuthHeader(cred) } : {},
    idleTimeoutMs: 5 * 60_000,
  }).catch((err: Error) => {
    throw new ScanError(pullFailure(reference, err.message))
  })
  // Progress arrives as JSON lines; per layer: {"id", "status", "progressDetail": {current, total}}.
  const layers = new Map<string, { current: number; total: number }>()
  let error: string | null = null
  let lastShown = 0
  const take = (value: unknown) => {
    const msg = value as { id?: string; status?: string; error?: string; progressDetail?: { current?: number; total?: number } }
    if (msg.error) error = msg.error
    if (msg.id && msg.status === "Downloading" && msg.progressDetail?.total) {
      layers.set(msg.id, { current: msg.progressDetail.current ?? 0, total: msg.progressDetail.total })
    } else if (msg.id && (msg.status === "Download complete" || msg.status === "Pull complete") && layers.has(msg.id)) {
      const l = layers.get(msg.id)!
      layers.set(msg.id, { current: l.total, total: l.total })
    }
  }
  const parser = new JsonLineParser()
  res.setEncoding("utf8")
  await new Promise<void>((resolve, reject) => {
    res.on("data", (chunk: string) => {
      parser.push(chunk).forEach(take)
      const total = [...layers.values()].reduce((s, l) => s + l.total, 0)
      const current = [...layers.values()].reduce((s, l) => s + l.current, 0)
      if (total && Date.now() - lastShown > 500) {
        lastShown = Date.now()
        phase(`Pulling scanner image (${Math.floor((current / total) * 100)}%)`)
      }
    })
    res.on("end", () => {
      parser.end().forEach(take)
      resolve()
    })
    res.on("error", reject)
  })
  if (error) throw new ScanError(pullFailure(reference, error))
  return null
}

function pullFailure(reference: string, message: string) {
  return (
    `Couldn't pull the scanner image ${reference}: ${message}. ` +
    "On a host without access to Docker Hub, push it to a registry it can reach and set TRIVY_IMAGE"
  ).slice(0, 1000)
}

/**
 * The content of the first regular file in a tar archive (GET /archive of
 * one file). Skips pax and GNU long-name headers. Null when there is none.
 */
export function firstTarFile(tar: Buffer): Buffer | null {
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) return null
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0[\s\S]*$/, "").trim() || "0", 8)
    const type = String.fromCharCode(header[156] || 48)
    const start = offset + 512
    if (type === "0" || type === "7") return tar.subarray(start, start + size)
    offset = start + Math.ceil(size / 512) * 512
  }
  return null
}

/** Copies `docker save` of the image into the (created) container, streaming. Returns the bytes copied. */
async function copyImage(target: DockerTarget, imageId: string, containerId: string, idleMs: number): Promise<number> {
  const source = await dockerStream(target, "GET", `/images/${idSeg(imageId)}/get`, { idleTimeoutMs: idleMs })
  let bytes = 0
  source.on("data", (c: Buffer) => (bytes += c.length))
  await new Promise<void>((resolve, reject) => {
    const put = dockerRequest(
      target,
      {
        method: "PUT",
        path: `/containers/${idSeg(containerId)}/archive?path=${enc(INPUT_DIR)}`,
        // No Content-Length: the export is streamed (chunked).
        headers: { "Content-Type": "application/x-tar" },
        timeout: idleMs,
      },
      (res) => {
        let body = ""
        res.on("data", (c: Buffer) => (body += c.toString("utf8")))
        res.on("end", () => {
          if ((res.statusCode ?? 500) < 400) return resolve()
          const message = dockerErrorMessage(body)
          reject(new DockerError(`Copying the image into the scanner failed: ${message}`, res.statusCode ?? 500))
        })
      }
    )
    put.on("timeout", () => put.destroy(new DockerError("Copying the image into the scanner stalled", 504)))
    put.on("error", (err: NodeJS.ErrnoException) => reject(connectionError(err)))
    source.on("error", (err) => {
      put.destroy()
      reject(connectionError(err as NodeJS.ErrnoException))
    })
    source.on("timeout", () => source.destroy())
    source.pipe(put)
  })
  return bytes
}

const NETWORK_RE =
  /(download(ing)? (the )?(vulnerability|java) (db|database)|failed to download|OCI repository error|dial tcp|no such host|i\/o timeout|TLS handshake timeout|connection refused|network is unreachable|temporary failure in name resolution|context deadline exceeded.*(ghcr|gcr|registry)|unable to (initialize|find) .*db)/i

/** A readable error from Trivy's log output (stderr), for a failed run. */
export function trivyFailure(log: string, exitCode: number): string {
  const lines = log
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
  const fatal = lines.filter((l) => /\b(FATAL|ERROR)\b/.test(l)).map((l) => l.replace(/^\S+ (FATAL|ERROR) /, ""))
  const detail = (fatal.length ? fatal : lines).slice(-3).join(" · ").slice(0, 600)
  if (NETWORK_RE.test(log)) {
    return (
      "Trivy couldn't download its vulnerability database; the environment seems to be offline or blocks the registry " +
      "(mirror.gcr.io / ghcr.io). Set TRIVY_DB_REPOSITORY to a reachable mirror, or preload the cache volume and set " +
      `TRIVY_SKIP_DB_UPDATE=true (see the README). Trivy said: ${detail || "nothing"}`
    ).slice(0, 1000)
  }
  if (/context deadline exceeded|timeout/i.test(detail)) return `Trivy timed out: ${detail}`.slice(0, 1000)
  return `Trivy failed (exit code ${exitCode})${detail ? `: ${detail}` : ""}`.slice(0, 1000)
}

/**
 * Scans one image of an environment with Trivy. `imageId` is the
 * daemon's id ("sha256:..."). Throws ScanError/DockerError with a message
 * for the user; the scanner container is always removed.
 */
export async function runTrivy(target: DockerTarget, imageId: string, opts: { phase?: Phase; timeoutMs?: number } = {}): Promise<TrivyRun> {
  const phase = opts.phase ?? (() => {})
  const timeoutMs = opts.timeoutMs ?? scanTimeoutMs()
  const deadline = Date.now() + timeoutMs
  const left = () => Math.max(1_000, deadline - Date.now())
  const scanner = trivyImage()
  const timings = { pull: 0, copy: 0, scan: 0 }

  let t = Date.now()
  const labelVersion = await ensureScannerImage(target, scanner, phase)
  timings.pull = Date.now() - t
  // Idempotent: returns the existing volume.
  await dockerJson(target, "POST", "/volumes/create", {
    body: { Name: trivyCacheVolume(), Labels: { [SCANNER_LABEL]: "cache" } },
    timeoutMs: 30_000,
  })

  phase("Preparing scanner")
  const env = FORWARDED_ENV.filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`)
  // Trivy's own deadline, a bit inside ours so it reports the timeout itself.
  const trivyTimeout = `${Math.max(60, Math.floor(timeoutMs / 1000) - 60)}s`
  const { Id } = await dockerJson<{ Id: string }>(target, "POST", "/containers/create", {
    query: { name: `gantry-scan-${imageId.replace(/^sha256:/, "").slice(0, 12)}-${Date.now().toString(36)}` },
    body: {
      Image: scanner,
      Entrypoint: ["trivy"],
      Cmd: [
        "image",
        "--input",
        INPUT_DIR,
        "--scanners",
        "vuln",
        "--format",
        "json",
        "--output",
        REPORT,
        "--cache-dir",
        CACHE_DIR,
        "--timeout",
        trivyTimeout,
        "--no-progress",
      ],
      Env: env,
      Labels: { [SCANNER_LABEL]: "true", [`${SCANNER_LABEL}.image`]: imageId },
      HostConfig: {
        Mounts: [{ Type: "volume", Source: trivyCacheVolume(), Target: CACHE_DIR }],
        // Removed by us after reading the report.
        AutoRemove: false,
      },
    },
    timeoutMs: 120_000,
  })

  try {
    phase("Exporting image")
    t = Date.now()
    await dockerRaw(target, "PUT", `/containers/${idSeg(Id)}/archive`, {
      query: { path: "/" },
      rawBody: { data: directoryTar(["scan/", "scan/image/"]), contentType: "application/x-tar" },
      timeoutMs: 60_000,
    })
    const imageBytes = await copyImage(target, imageId, Id, Math.min(left(), 5 * 60_000))
    timings.copy = Date.now() - t
    if (Date.now() >= deadline) throw new ScanError("The scan timed out while exporting the image")

    phase("Scanning")
    t = Date.now()
    await dockerRaw(target, "POST", `/containers/${idSeg(Id)}/start`, { timeoutMs: 60_000 })
    let exitCode: number
    try {
      const wait = await dockerJson<{ StatusCode: number }>(target, "POST", `/containers/${idSeg(Id)}/wait`, { timeoutMs: left() })
      exitCode = wait.StatusCode
    } catch (err) {
      if (err instanceof DockerError && err.status === 504) {
        throw new ScanError(`The scan didn't finish within ${Math.round(timeoutMs / 60_000)} minutes (TRIVY_TIMEOUT_MINUTES)`)
      }
      throw err
    }
    timings.scan = Date.now() - t

    if (exitCode !== 0) {
      const { body } = await dockerRaw(target, "GET", `/containers/${idSeg(Id)}/logs`, {
        query: { stdout: 1, stderr: 1, tail: 40 },
        timeoutMs: 30_000,
      })
      throw new ScanError(trivyFailure(demuxLogs(body), exitCode))
    }

    const { body: reportTar } = await dockerRaw(target, "GET", `/containers/${idSeg(Id)}/archive`, {
      query: { path: REPORT },
      timeoutMs: 120_000,
    })
    const reportFile = firstTarFile(reportTar)
    if (!reportFile) throw new ScanError("Trivy produced no report")
    let report: unknown
    try {
      report = JSON.parse(reportFile.toString("utf8"))
    } catch {
      throw new ScanError("Trivy's report isn't valid JSON")
    }

    let dbVersion: string | null = null
    try {
      const { body } = await dockerRaw(target, "GET", `/containers/${idSeg(Id)}/archive`, {
        query: { path: `${CACHE_DIR}/db/metadata.json` },
        timeoutMs: 30_000,
      })
      const meta = JSON.parse(firstTarFile(body)?.toString("utf8") ?? "{}") as { UpdatedAt?: string }
      dbVersion = typeof meta.UpdatedAt === "string" ? meta.UpdatedAt.slice(0, 64) : null
    } catch {
      // Older/newer cache layouts: the scan is still valid without it.
    }
    const reportVersion = (report as { Trivy?: { Version?: unknown } }).Trivy?.Version
    const tagVersion = splitImageRef(scanner).tag?.replace(/^v/, "")
    const trivyVersion =
      (typeof reportVersion === "string" ? reportVersion : null) ??
      labelVersion ??
      (tagVersion && /^\d/.test(tagVersion) ? tagVersion : null)

    return { report, trivyVersion: trivyVersion?.slice(0, 32) ?? null, dbVersion, imageBytes, timings }
  } finally {
    // Removal can take minutes on a busy daemon; the sweep retries if it fails.
    await dockerRaw(target, "DELETE", `/containers/${idSeg(Id)}`, { query: { force: true, v: true }, timeoutMs: 180_000 }).catch(
      (err) => console.warn(`[gantry] couldn't remove scanner container ${Id.slice(0, 12)}: ${(err as Error).message}`)
    )
  }
}

/**
 * Removes scanner containers left behind (Gantry restarted mid-scan): those
 * that exited a while ago, and any older than the longest scan. Another
 * Gantry using the same daemon may be scanning, so recent ones that are
 * still being filled or running stay.
 */
export async function sweepScanners(target: DockerTarget) {
  const list = await dockerJson<{ Id: string; State: string; Created: number }[]>(target, "GET", "/containers/json", {
    query: { all: true, filters: JSON.stringify({ label: [`${SCANNER_LABEL}=true`] }) },
    timeoutMs: 30_000,
  })
  const now = Date.now() / 1000
  let removed = 0
  for (const c of list) {
    const age = now - c.Created
    const finished = c.State === "exited" || c.State === "dead"
    if ((finished && age > 600) || age > scanTimeoutMs() / 1000 + 600) {
      await dockerRaw(target, "DELETE", `/containers/${idSeg(c.Id)}`, { query: { force: true, v: true }, timeoutMs: 60_000 })
        .then(() => removed++)
        .catch(() => {})
    }
  }
  return removed
}
