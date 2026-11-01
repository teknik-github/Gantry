import "server-only"

import type http from "node:http"

import { looksBinary, sortEntries, type FileEntry, type FileTarget, type Listing } from "@/lib/files/entries"
import { baseName, joinPath, mountedPath, nameError, normalizePath, PathError } from "@/lib/files/paths"
import type { ContainerInspect, DockerApi } from "@/lib/server/docker/api"
import { dockerJson, DockerError, type DockerTarget } from "@/lib/server/docker/client"
import { dockerSend, dockerStream, execCapture } from "@/lib/server/docker/stream"
import { filesConfig } from "@/lib/server/files/config"
import { LIST_ENV, listCommand, NOT_A_DIRECTORY, parseStatOutput } from "@/lib/server/files/exec-list"
import { acquireHelper, VOLUME_MOUNT, withHelper, type Helper } from "@/lib/server/files/helper"
import { DirectoryCollector, TarReader, type TarEntry } from "@/lib/server/files/tar-read"
import { directoryTar, fileTarLength, fileTarStream, tarHeader } from "@/lib/server/tar"

/**
 * File operations for the file browser, on a container's filesystem or a
 * volume (through a helper container, lib/server/files/helper.ts).
 *
 * - Listing: `stat` through exec when the container runs and has a shell;
 *   otherwise (stopped, paused, distroless) the headers of Docker's tar
 *   archive of the folder, skipping file bodies, within FILES_SCAN_* limits.
 * - Download, read, upload, new folder: the archive API (GET/HEAD/PUT
 *   /containers/{id}/archive), which works whether or not the container runs.
 * - Delete: `rm` through exec, so only in running containers with rm.
 *
 * Volume paths never go through a symbolic link: the helper checks every
 * component first (exec), so a link inside a volume can't make an operation
 * land outside it.
 */

export type { FileTarget }

export class FilesError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code?: "exists"
  ) {
    super(message)
    this.name = "FilesError"
  }
}

const CONTAINER_ID = /^[a-f0-9]{12,64}$/
const VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/

/** The target named by ?container=<id> or ?volume=<name>. */
export function parseTarget(input: { container?: unknown; volume?: unknown }): FileTarget {
  const { container, volume } = input
  if (typeof container === "string" && container && !volume) {
    if (!CONTAINER_ID.test(container)) throw new FilesError("Invalid container id")
    return { kind: "container", id: container }
  }
  if (typeof volume === "string" && volume && !container) {
    if (!VOLUME_NAME.test(volume)) throw new FilesError("Invalid volume name")
    return { kind: "volume", name: volume }
  }
  throw new FilesError("Name a container or a volume")
}

/** Validated, normalized path (PathError → 400). */
export function parsePath(value: unknown): string {
  try {
    return normalizePath(value ?? "/")
  } catch (err) {
    if (err instanceof PathError) throw new FilesError(err.message)
    throw err
  }
}

export function parseName(value: unknown): string {
  const error = nameError(value)
  if (error) throw new FilesError(error)
  return value as string
}

/** For the audit log: "container web-1:/etc/hosts", "volume data:/x". */
export function describe(target: FileTarget, path: string, containerName?: string) {
  return target.kind === "container"
    ? `container ${containerName ?? target.id.slice(0, 12)}:${path}`
    : `volume ${target.name}:${path}`
}

// ---- Docker archive stat --------------------------------------------------

/** X-Docker-Container-Path-Stat; mode is a Go os.FileMode. */
export type PathStat = { name: string; size: number; mode: number; mtime: string; linkTarget: string }

const GO_DIR = 2 ** 31
const GO_SYMLINK = 2 ** 27
const bit = (mode: number, b: number) => Math.floor(mode / b) % 2 === 1
export const isDir = (s: PathStat) => bit(s.mode, GO_DIR)
export const isSymlink = (s: PathStat) => bit(s.mode, GO_SYMLINK)
/** Regular file: none of the Go type bits (dir, append, exclusive, temp, symlink, device, pipe, socket, ...) set. */
export const isRegular = (s: PathStat) => Math.floor(s.mode / 2 ** 19) === 0

/** Stat of a path inside a container (HEAD archive); null when it doesn't exist. Doesn't follow a final symlink. */
export async function statPath(target: DockerTarget, containerId: string, path: string): Promise<PathStat | null> {
  let res: http.IncomingMessage
  try {
    res = await dockerStream(target, "HEAD", `/containers/${containerId}/archive`, { query: { path } })
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) return null
    throw err
  }
  res.resume()
  const header = res.headers["x-docker-container-path-stat"]
  if (typeof header !== "string") throw new DockerError("Docker sent no path information", 502)
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PathStat
}

// ---- Targets --------------------------------------------------------------

async function inspectContainer(api: DockerApi, id: string): Promise<ContainerInspect> {
  try {
    return await api.inspectContainer(id)
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) throw new FilesError("No such container", 404)
    throw err
  }
}

export async function inspectVolume(api: DockerApi, name: string) {
  try {
    return await dockerJson<{ Name: string; Driver: string; Mountpoint: string }>(api.target, "GET", `/volumes/${encodeURIComponent(name)}`)
  } catch (err) {
    if (err instanceof DockerError && err.status === 404) throw new FilesError("No such volume", 404)
    throw err
  }
}

const isRunning = (c: ContainerInspect) => c.State.Running && !c.State.Paused && !c.State.Restarting

/** Exit code of GUARD_SCRIPT when a path component is a symbolic link. */
const SYMLINK_IN_PATH = 4
const GUARD_SCRIPT = 'p=$1; shift; for c do p="$p/$c"; if [ -L "$p" ]; then printf "%s" "$p"; exit 4; fi; done'

/** Refuses a volume path that goes through a symbolic link (components checked inside the helper). */
async function guardVolumePath(target: DockerTarget, helper: Helper, path: string, opts: { allowFinalLink?: boolean } = {}) {
  const components = path.split("/").filter(Boolean)
  if (opts.allowFinalLink) components.pop()
  if (!components.length) return
  const res = await execCapture(target, helper.id, ["sh", "-c", GUARD_SCRIPT, "gantry-guard", VOLUME_MOUNT, ...components], {
    maxBytes: 8192,
    timeoutMs: 30_000,
  })
  if (res.exitCode === SYMLINK_IN_PATH) {
    const link = res.stdout.toString("utf8").slice(VOLUME_MOUNT.length) || path
    throw new FilesError(`${link} is a symbolic link; the file browser doesn't follow links inside volumes`, 400)
  }
  if (res.exitCode !== 0) throw new FilesError(`Could not check the path in the volume (exit ${res.exitCode})`, 500)
}

// ---- Listing ---------------------------------------------------------------

function capEntries(entries: FileEntry[], truncated: string | undefined): { entries: FileEntry[]; truncated?: string } {
  const { listMaxEntries } = filesConfig()
  const sorted = sortEntries(entries)
  if (sorted.length <= listMaxEntries) return { entries: sorted, truncated }
  return {
    entries: sorted.slice(0, listMaxEntries),
    truncated: truncated ?? `Showing the first ${listMaxEntries} of ${sorted.length} entries.`,
  }
}

/** Lists through exec; null when exec isn't possible (no shell or stat), so the caller falls back. */
async function listViaExec(target: DockerTarget, containerId: string, dir: string, shown = dir): Promise<Listing | null> {
  let res
  try {
    res = await execCapture(target, containerId, listCommand(dir), {
      env: LIST_ENV,
      user: "0",
      maxBytes: 32 * 1024 * 1024,
      timeoutMs: 60_000,
    })
  } catch (err) {
    // Not running any more, or the runtime refused the exec: use the archive.
    if (err instanceof DockerError && err.status !== 504) return null
    throw err
  }
  if (res.exitCode === NOT_A_DIRECTORY) throw new FilesError(`${shown} is not a folder (or doesn't exist)`, 404)
  // 126/127: no sh or no stat; -1: still running (killed); 125+: runtime errors.
  if (res.exitCode < 0 || res.exitCode >= 125) return null
  const parsed = parseStatOutput(res.stdout.toString("utf8"))
  const capped = capEntries(parsed, res.truncated ? "The listing was too large and has been cut short." : undefined)
  return { path: shown, source: "exec", ...capped }
}

/**
 * Lists from the tar archive of the folder: reads headers, skips bodies, but
 * Docker still sends every file below the folder, so stop at the scan limits.
 */
async function listViaArchive(target: DockerTarget, containerId: string, dir: string, signal?: AbortSignal): Promise<Omit<Listing, "path">> {
  const { scanMaxBytes, scanTimeoutMs, listMaxEntries } = filesConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), scanTimeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener("abort", onAbort, { once: true })
  const collector = new DirectoryCollector(listMaxEntries)
  let stopped: string | undefined
  let selfChecked = false
  const reader = new TarReader({
    onEntry(entry: TarEntry) {
      collector.add(entry)
      if (!selfChecked) {
        selfChecked = true
        if (entry.type !== "dir") throw new FilesError(`${dir} is not a folder`, 404)
      }
    },
  })
  let res: http.IncomingMessage | null = null
  try {
    res = await dockerStream(target, "GET", `/containers/${containerId}/archive`, {
      query: { path: dir },
      signal: controller.signal,
    })
    for await (const chunk of res as AsyncIterable<Buffer>) {
      if (!reader.push(chunk)) break
      if (reader.bytes > scanMaxBytes) {
        stopped = `Stopped after reading ${Math.round(reader.bytes / 1024 / 1024)} MB of the folder's archive (FILES_SCAN_MAX_MB); entries after that point are missing.`
        break
      }
    }
  } catch (err) {
    if (controller.signal.aborted && !signal?.aborted && collector.scan.self) {
      stopped = `Stopped after ${scanTimeoutMs / 1000} s (FILES_SCAN_TIMEOUT_SECONDS); entries after that point are missing.`
    } else if (err instanceof DockerError && err.status === 404) {
      throw new FilesError(`${dir} doesn't exist`, 404)
    } else if (controller.signal.aborted && !signal?.aborted) {
      throw new FilesError(`Docker took longer than ${scanTimeoutMs / 1000} s to send the folder`, 504)
    } else {
      throw err
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
    res?.destroy()
  }
  const { children, dropped } = collector.scan
  const truncated =
    stopped ?? (dropped ? `Showing the first ${children.length} of ${children.length + dropped} entries.` : undefined)
  return { source: "archive", ...capEntries(children, truncated) }
}

/** Container listing: exec when it runs, archive otherwise. Follows a symlinked folder. */
async function listContainer(api: DockerApi, id: string, dir: string, signal?: AbortSignal): Promise<Listing> {
  const info = await inspectContainer(api, id)
  if (isRunning(info)) {
    const viaExec = await listViaExec(api.target, info.Id, dir)
    if (viaExec) return viaExec
  }
  // The archive of a symlink is the link itself: list where it points.
  let path = dir
  for (let hops = 0; hops < 8; hops++) {
    const stat = await statPath(api.target, info.Id, path)
    if (!stat) throw new FilesError(`${dir} doesn't exist`, 404)
    if (!isSymlink(stat)) {
      if (!isDir(stat)) throw new FilesError(`${dir} is not a folder`, 404)
      break
    }
    path = normalizePath(stat.linkTarget, { clamp: true })
  }
  return { path: dir, ...(await listViaArchive(api.target, info.Id, path, signal)) }
}

export async function listFiles(api: DockerApi, target: FileTarget, dir: string, signal?: AbortSignal): Promise<Listing> {
  if (target.kind === "container") return listContainer(api, target.id, dir, signal)
  await inspectVolume(api, target.name)
  return withHelper(api, target.name, { write: false }, async (helper) => {
    await guardVolumePath(api.target, helper, dir)
    const inner = mountedPath(VOLUME_MOUNT, dir)
    const viaExec = await listViaExec(api.target, helper.id, inner, dir)
    if (viaExec) return viaExec
    return { path: dir, ...(await listViaArchive(api.target, helper.id, inner, signal)) }
  })
}

// ---- Reading ----------------------------------------------------------------

type OpenedFile = { entry: TarEntry; body: AsyncGenerator<Buffer> }

/**
 * Reads the first entry of an archive response: resolves once its header is
 * known (for Content-Length), then streams exactly its body and closes the
 * response.
 */
async function openSingleFile(res: http.IncomingMessage): Promise<OpenedFile> {
  const it = (res as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
  let entry: TarEntry | null = null
  let pending: Buffer[] = []
  let sent = 0
  const reader = new TarReader({
    onEntry(e) {
      if (entry) return "stop"
      entry = e
    },
    onData(chunk, e) {
      if (e === entry) pending.push(chunk)
    },
  })
  try {
    while (!entry) {
      const { value, done } = await it.next()
      if (done) throw new FilesError("Docker sent an empty archive", 502)
      reader.push(value)
    }
  } catch (err) {
    res.destroy()
    throw err
  }
  const first = entry as TarEntry
  async function* body() {
    try {
      while (true) {
        const out = pending
        pending = []
        for (const chunk of out) {
          sent += chunk.length
          yield chunk
        }
        if (first.type !== "file" || sent >= first.size || reader.done) return
        const { value, done } = await it.next()
        if (done) return
        reader.push(value)
      }
    } finally {
      res.destroy()
    }
  }
  return { entry: first, body: body() }
}

export type Download = {
  filename: string
  /** "file": raw bytes of one file; "tar": an archive of a folder. */
  kind: "file" | "tar"
  size?: number
  body: AsyncIterable<Buffer>
  /** Called once when the transfer ends or is cancelled. */
  cleanup?: () => void | Promise<void>
}

async function resolveForRead(
  target: DockerTarget,
  containerId: string,
  path: string,
  inVolume: boolean
): Promise<{ path: string; stat: PathStat }> {
  let current = path
  for (let hops = 0; hops < 8; hops++) {
    const stat = await statPath(target, containerId, current)
    if (!stat) throw new FilesError(`${inVolume ? current.slice(VOLUME_MOUNT.length) || "/" : current} doesn't exist`, 404)
    if (!isSymlink(stat)) return { path: current, stat }
    if (inVolume) throw new FilesError("This is a symbolic link; open its target instead", 400)
    current = normalizePath(stat.linkTarget, { clamp: true })
  }
  throw new FilesError("Too many levels of symbolic links", 400)
}

async function openDownloadIn(target: DockerTarget, containerId: string, inner: string, shown: string, inVolume: boolean): Promise<Download> {
  const { path, stat } = await resolveForRead(target, containerId, inner, inVolume)
  const res = await dockerStream(target, "GET", `/containers/${containerId}/archive`, {
    query: { path },
    // Large folders: the daemon may pause while reading; allow for it.
    idleTimeoutMs: 5 * 60_000,
  })
  if (isDir(stat)) {
    const name = baseName(shown) || "root"
    return { filename: `${name}.tar`, kind: "tar", body: res as AsyncIterable<Buffer> }
  }
  const { entry, body } = await openSingleFile(res)
  if (entry.type !== "file") {
    await body.return(undefined)
    throw new FilesError("Only regular files and folders can be downloaded", 400)
  }
  return { filename: baseName(shown) || "file", kind: "file", size: entry.size, body }
}

export async function openDownload(api: DockerApi, target: FileTarget, path: string): Promise<Download> {
  if (target.kind === "container") {
    const info = await inspectContainer(api, target.id)
    return openDownloadIn(api.target, info.Id, path, path, false)
  }
  await inspectVolume(api, target.name)
  const helper = await acquireHelper(api, target.name, { write: false })
  try {
    await guardVolumePath(api.target, helper, path, { allowFinalLink: true })
    const download = await openDownloadIn(api.target, helper.id, mountedPath(VOLUME_MOUNT, path), path, true)
    return { ...download, cleanup: () => helper.release() }
  } catch (err) {
    helper.release()
    throw err
  }
}

export type TextFile =
  | { ok: true; content: string; size: number; mode: number }
  | { ok: false; reason: "binary" | "too-large" | "not-a-file"; size: number }

/** A small text file for the editor (≤ FILES_EDIT_MAX_KB, valid UTF-8 without NUL bytes). */
export async function readTextFile(api: DockerApi, target: FileTarget, path: string): Promise<TextFile> {
  const { editMaxBytes } = filesConfig()
  const read = async (t: DockerTarget, containerId: string, inner: string, inVolume: boolean): Promise<TextFile> => {
    const { path: resolved, stat } = await resolveForRead(t, containerId, inner, inVolume)
    if (!isRegular(stat)) return { ok: false, reason: "not-a-file", size: stat.size }
    if (stat.size > editMaxBytes) return { ok: false, reason: "too-large", size: stat.size }
    const res = await dockerStream(t, "GET", `/containers/${containerId}/archive`, { query: { path: resolved } })
    const { entry, body } = await openSingleFile(res)
    if (entry.size > editMaxBytes) {
      await body.return(undefined)
      return { ok: false, reason: "too-large", size: entry.size }
    }
    const chunks: Buffer[] = []
    for await (const chunk of body) chunks.push(chunk)
    const data = Buffer.concat(chunks)
    if (looksBinary(data)) return { ok: false, reason: "binary", size: data.length }
    return { ok: true, content: data.toString("utf8"), size: data.length, mode: entry.mode }
  }
  if (target.kind === "container") {
    const info = await inspectContainer(api, target.id)
    return read(api.target, info.Id, path, false)
  }
  await inspectVolume(api, target.name)
  return withHelper(api, target.name, { write: false }, async (helper) => {
    await guardVolumePath(api.target, helper, path, { allowFinalLink: true })
    return read(api.target, helper.id, mountedPath(VOLUME_MOUNT, path), true)
  })
}

// ---- Writing -----------------------------------------------------------------

/** Owner and mode of an existing regular file (first header of its archive), to keep them on overwrite. */
async function existingOwner(target: DockerTarget, containerId: string, path: string) {
  const res = await dockerStream(target, "GET", `/containers/${containerId}/archive`, { query: { path } })
  const { entry, body } = await openSingleFile(res)
  await body.return(undefined)
  return { uid: entry.uid, gid: entry.gid, mode: entry.mode }
}

/**
 * The folder to write into, following symbolic links in a container (never
 * in a volume: guardVolumePath already refused those).
 */
async function checkFolder(target: DockerTarget, containerId: string, dir: string, shown: string, inVolume: boolean): Promise<string> {
  let current = dir
  for (let hops = 0; hops < 8; hops++) {
    const stat = await statPath(target, containerId, current)
    if (!stat) throw new FilesError(`${shown} doesn't exist`, 404)
    if (isSymlink(stat) && !inVolume) {
      current = normalizePath(stat.linkTarget, { clamp: true })
      continue
    }
    if (!isDir(stat)) throw new FilesError(`${shown} is not a folder`, 400)
    return current
  }
  throw new FilesError("Too many levels of symbolic links", 400)
}

export type Upload = {
  dir: string
  name: string
  size: number
  body: AsyncIterable<Uint8Array>
  /** Replace an existing file (else a 409 with code "exists"). */
  overwrite: boolean
}

async function uploadIn(target: DockerTarget, containerId: string, folder: string, upload: Upload, inVolume: boolean) {
  const innerDir = await checkFolder(target, containerId, folder, upload.dir, inVolume)
  const innerPath = joinPath(innerDir, upload.name)
  const existing = await statPath(target, containerId, innerPath)
  let owner = { uid: 0, gid: 0, mode: 0o644 }
  if (existing) {
    if (isDir(existing)) throw new FilesError(`A folder named ${upload.name} already exists`, 409)
    if (isSymlink(existing)) throw new FilesError(`${upload.name} is a symbolic link; replace its target instead`, 409)
    if (!isRegular(existing)) throw new FilesError(`${upload.name} is not a regular file`, 409)
    if (!upload.overwrite) throw new FilesError(`${upload.name} already exists`, 409, "exists")
    owner = await existingOwner(target, containerId, innerPath)
  }
  const header = tarHeader({ name: upload.name, type: "file", size: upload.size, ...owner })
  await dockerSend(target, "PUT", `/containers/${containerId}/archive`, {
    query: { path: innerDir },
    body: {
      data: fileTarStream(header, upload.size, upload.body),
      contentType: "application/x-tar",
      length: fileTarLength(header, upload.size),
    },
    idleTimeoutMs: 5 * 60_000,
  })
}

export async function uploadFile(api: DockerApi, target: FileTarget, upload: Upload) {
  if (target.kind === "container") {
    const info = await inspectContainer(api, target.id)
    return uploadIn(api.target, info.Id, upload.dir, upload, false)
  }
  await inspectVolume(api, target.name)
  return withHelper(api, target.name, { write: true }, async (helper) => {
    await guardVolumePath(api.target, helper, joinPath(upload.dir, upload.name))
    return uploadIn(api.target, helper.id, mountedPath(VOLUME_MOUNT, upload.dir), upload, true)
  })
}

async function mkdirIn(target: DockerTarget, containerId: string, folder: string, dir: string, name: string, inVolume: boolean) {
  const innerDir = await checkFolder(target, containerId, folder, dir, inVolume)
  if (await statPath(target, containerId, joinPath(innerDir, name))) throw new FilesError(`${name} already exists`, 409)
  await dockerSend(target, "PUT", `/containers/${containerId}/archive`, {
    query: { path: innerDir },
    body: { data: directoryTar(name), contentType: "application/x-tar" },
  })
}

export async function createFolder(api: DockerApi, target: FileTarget, dir: string, name: string) {
  if (target.kind === "container") {
    const info = await inspectContainer(api, target.id)
    return mkdirIn(api.target, info.Id, dir, dir, name, false)
  }
  await inspectVolume(api, target.name)
  return withHelper(api, target.name, { write: true }, async (helper) => {
    await guardVolumePath(api.target, helper, joinPath(dir, name))
    return mkdirIn(api.target, helper.id, mountedPath(VOLUME_MOUNT, dir), dir, name, true)
  })
}

/** Why deleting is impossible in this container right now, or null. */
export function deleteBlocker(info: Pick<ContainerInspect, "State">): string | null {
  if (info.State.Paused) return "Deleting needs a running container; this one is paused."
  if (!info.State.Running || info.State.Restarting) {
    return "Deleting needs a running container: Docker can only remove files through a command inside it."
  }
  return null
}

async function rmIn(target: DockerTarget, containerId: string, inner: string) {
  const res = await execCapture(target, containerId, ["rm", "-rf", "--", inner], { user: "0", maxBytes: 64 * 1024, timeoutMs: 5 * 60_000 })
  if (res.exitCode === 126 || res.exitCode === 127) throw new FilesError("This container has no rm command, so files can't be deleted", 400)
  if (res.exitCode !== 0) {
    const detail = (res.stderr.toString("utf8") || res.stdout.toString("utf8")).trim().split("\n")[0]
    throw new FilesError(detail ? `Delete failed: ${detail}` : `Delete failed (exit ${res.exitCode})`, 400)
  }
}

export async function deletePath(api: DockerApi, target: FileTarget, path: string) {
  if (path === "/") throw new FilesError("The root folder can't be deleted")
  if (target.kind === "container") {
    const info = await inspectContainer(api, target.id)
    const blocker = deleteBlocker(info)
    if (blocker) throw new FilesError(blocker, 409)
    if (!(await statPath(api.target, info.Id, path))) throw new FilesError(`${path} doesn't exist`, 404)
    return rmIn(api.target, info.Id, path)
  }
  await inspectVolume(api, target.name)
  return withHelper(api, target.name, { write: true }, async (helper) => {
    // The final component may itself be a link: rm removes the link, not its target.
    await guardVolumePath(api.target, helper, path, { allowFinalLink: true })
    const inner = mountedPath(VOLUME_MOUNT, path)
    if (!(await statPath(api.target, helper.id, inner))) throw new FilesError(`${path} doesn't exist`, 404)
    return rmIn(api.target, helper.id, inner)
  })
}

