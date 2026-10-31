import "server-only"

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Readable, Transform, type TransformCallback } from "node:stream"

import { DEFAULT_DOCKERFILE, looksLikeArchive, type EditorSource } from "@/lib/image-build"

// Build contexts for POST /build: tar archives (ustar, with pax headers for
// long names) written from the editor's files or from a directory (a Git
// checkout), and a size/format guard for uploaded archives. lib/server/tar.ts
// only writes single flat files; contexts need folders, modes and symlinks.

/** A context problem the user can fix (shown as the build error). */
export class ContextError extends Error {}

const BLOCK = 512
const END = Buffer.alloc(BLOCK * 2)

type Entry = {
  path: string
  type: "file" | "dir" | "symlink"
  size: number
  mode: number
  mtime: number
  linkname?: string
}

function octal(value: number, length: number) {
  return value.toString(8).padStart(length - 1, "0") + "\0"
}

function paxRecord(key: string, value: string) {
  // "<len> key=value\n" where <len> counts the whole record, itself included.
  const body = ` ${key}=${value}\n`
  let len = Buffer.byteLength(body) + 1
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body)
  return `${len}${body}`
}

function rawHeader(name: string, e: { type: string; size: number; mode: number; mtime: number; linkname?: string }) {
  const h = Buffer.alloc(BLOCK, 0)
  h.write(name, 0, 100, "utf8")
  h.write(octal(e.mode & 0o7777, 8), 100, "ascii")
  h.write(octal(0, 8), 108, "ascii")
  h.write(octal(0, 8), 116, "ascii")
  h.write(octal(e.size, 12), 124, "ascii")
  h.write(octal(Math.max(0, Math.floor(e.mtime)), 12), 136, "ascii")
  h.write("        ", 148, "ascii")
  h.write(e.type, 156, "ascii")
  if (e.linkname) h.write(e.linkname, 157, 100, "utf8")
  h.write("ustar\0", 257, "ascii")
  h.write("00", 263, "ascii")
  let sum = 0
  for (const b of h) sum += b
  h.write(octal(sum, 7) + " ", 148, "ascii")
  return h
}

const pad = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK, 0)

/**
 * Header block(s) for one entry. Names or link targets that don't fit
 * ustar's 100 bytes (or aren't ASCII) get a pax extended header first.
 */
export function tarHeader(entry: Entry): Buffer {
  const name = entry.type === "dir" ? `${entry.path}/` : entry.path
  const type = entry.type === "file" ? "0" : entry.type === "dir" ? "5" : "2"
  const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s)
  const longName = Buffer.byteLength(name) > 100 || !ascii(name)
  const longLink = entry.linkname !== undefined && (Buffer.byteLength(entry.linkname) > 100 || !ascii(entry.linkname))
  const main = rawHeader(longName ? name.replace(/[^\x20-\x7e]/g, "_").slice(0, 99) : name, {
    type,
    size: entry.type === "file" ? entry.size : 0,
    mode: entry.mode,
    mtime: entry.mtime,
    linkname: entry.linkname && longLink ? entry.linkname.replace(/[^\x20-\x7e]/g, "_").slice(0, 99) : entry.linkname,
  })
  if (!longName && !longLink) return main
  const records = Buffer.from(
    (longName ? paxRecord("path", name) : "") + (longLink ? paxRecord("linkpath", entry.linkname!) : ""),
    "utf8"
  )
  const pax = rawHeader("PaxHeaders/entry", { type: "x", size: records.length, mode: 0o644, mtime: entry.mtime })
  return Buffer.concat([pax, records, pad(records.length), main])
}

/** The editor's Dockerfile plus extra files (parent folders added) as one tar. */
export function editorContext(source: EditorSource): Buffer {
  const now = Math.floor(Date.now() / 1000)
  const parts: Buffer[] = []
  const dirs = new Set<string>()
  const files = [{ path: DEFAULT_DOCKERFILE, content: source.dockerfile }, ...source.files]
  for (const f of files) {
    const segments = f.path.split("/")
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join("/")
      if (dirs.has(dir)) continue
      dirs.add(dir)
      parts.push(tarHeader({ path: dir, type: "dir", size: 0, mode: 0o755, mtime: now }))
    }
    const data = Buffer.from(f.content, "utf8")
    // Scripts next to the Dockerfile keep working when RUN executes them directly.
    const mode = /\.sh$/.test(f.path) || f.content.startsWith("#!") ? 0o755 : 0o644
    parts.push(tarHeader({ path: f.path, type: "file", size: data.length, mode, mtime: now }), data, pad(data.length))
  }
  parts.push(END)
  return Buffer.concat(parts)
}

/**
 * Streams `dir` as a tar archive: regular files, folders and symlinks (kept
 * as links, never followed); `.git` folders and anything else (sockets,
 * devices) are skipped. Stops with a ContextError past `maxBytes`.
 */
export function directoryContext(dir: string, opts: { maxBytes: number; maxEntries?: number }): Readable {
  const maxEntries = opts.maxEntries ?? 200_000
  let bytes = 0
  let entries = 0

  const count = (n: number) => {
    bytes += n
    if (bytes > opts.maxBytes) {
      throw new ContextError(`The build context is larger than ${formatLimit(opts.maxBytes)}`)
    }
  }

  async function* walk(abs: string, rel: string): AsyncGenerator<Buffer> {
    const names = (await fsp.readdir(/* turbopackIgnore: true */ abs)).sort()
    for (const name of names) {
      if (name === ".git") continue
      const full = path.join(/* turbopackIgnore: true */ abs, name)
      const relPath = rel ? `${rel}/${name}` : name
      const st = await fsp.lstat(full)
      const base = { path: relPath, mode: st.mode, mtime: st.mtimeMs / 1000 }
      if (++entries > maxEntries) throw new ContextError(`The build context has more than ${maxEntries} files`)
      if (st.isSymbolicLink()) {
        const header = tarHeader({ ...base, type: "symlink", size: 0, linkname: await fsp.readlink(full) })
        count(header.length)
        yield header
      } else if (st.isDirectory()) {
        const header = tarHeader({ ...base, type: "dir", size: 0 })
        count(header.length)
        yield header
        yield* walk(full, relPath)
      } else if (st.isFile()) {
        const header = tarHeader({ ...base, type: "file", size: st.size })
        count(header.length + st.size + pad(st.size).length)
        yield header
        let read = 0
        for await (const chunk of fs.createReadStream(/* turbopackIgnore: true */ full)) {
          read += (chunk as Buffer).length
          if (read > st.size) throw new ContextError(`${relPath} changed while it was read`)
          yield chunk as Buffer
        }
        if (read !== st.size) throw new ContextError(`${relPath} changed while it was read`)
        yield pad(st.size)
      }
    }
  }

  async function* archive() {
    yield* walk(dir, "")
    yield END
  }

  return Readable.from(archive(), { objectMode: false })
}

/**
 * Pass-through for an uploaded archive: refuses data that isn't a tar (or
 * gzip/bzip2/xz) and stops with a ContextError past `maxBytes`.
 */
export function uploadGuard(maxBytes: number): Transform {
  let bytes = 0
  let head: Buffer | null = Buffer.alloc(0)
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      bytes += chunk.length
      if (bytes > maxBytes) return done(new ContextError(`The archive is larger than ${formatLimit(maxBytes)}`))
      if (head === null) return done(null, chunk)
      head = Buffer.concat([head, chunk])
      if (head.length < 262 && !looksLikeArchive(head)) return done()
      if (!looksLikeArchive(head)) return done(new ContextError("The upload is not a tar archive (.tar or .tar.gz)"))
      const out = head
      head = null
      done(null, out)
    },
    flush(done: TransformCallback) {
      if (head !== null) {
        if (!head.length) return done(new ContextError("The archive is empty"))
        if (!looksLikeArchive(head)) return done(new ContextError("The upload is not a tar archive (.tar or .tar.gz)"))
        this.push(head)
      }
      done()
    },
  })
}

export function formatLimit(bytes: number) {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`
}

/**
 * Resolves `rel` inside `root` (symlinks included) and refuses anything that
 * leaves it. Returns the real path.
 */
export async function resolveInside(root: string, rel: string, what: string): Promise<string> {
  const realRoot = await fsp.realpath(/* turbopackIgnore: true */ root)
  let real: string
  try {
    real = await fsp.realpath(path.join(/* turbopackIgnore: true */ root, rel))
  } catch {
    throw new ContextError(`${what} ${rel || "."} was not found in the repository`)
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new ContextError(`${what} ${rel} points outside the repository`)
  }
  return real
}
