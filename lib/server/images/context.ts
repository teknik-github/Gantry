import "server-only"

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { Readable, Transform, type TransformCallback } from "node:stream"

import { DEFAULT_DOCKERFILE, looksLikeArchive, type EditorSource } from "@/lib/image-build"
import { padding, TAR_END, tarHeader } from "@/lib/server/tar"

// Build contexts for POST /build: tar archives written from the editor's
// files or from a directory (a Git checkout), and a size/format guard for
// uploaded archives.

/** A context problem the user can fix (shown as the build error). */
export class ContextError extends Error {}

const pad = (size: number) => Buffer.alloc(padding(size), 0)

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
      parts.push(tarHeader({ name: dir, type: "dir", mode: 0o755, mtime: now }))
    }
    const data = Buffer.from(f.content, "utf8")
    // Scripts next to the Dockerfile keep working when RUN executes them directly.
    const mode = /\.sh$/.test(f.path) || f.content.startsWith("#!") ? 0o755 : 0o644
    parts.push(tarHeader({ name: f.path, type: "file", size: data.length, mode, mtime: now }), data, pad(data.length))
  }
  parts.push(TAR_END)
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
      const base = { name: relPath, mode: st.mode, mtime: st.mtimeMs / 1000 }
      if (++entries > maxEntries) throw new ContextError(`The build context has more than ${maxEntries} files`)
      if (st.isSymbolicLink()) {
        const header = tarHeader({ ...base, type: "symlink", linkname: await fsp.readlink(full) })
        count(header.length)
        yield header
      } else if (st.isDirectory()) {
        const header = tarHeader({ ...base, type: "dir" })
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
    yield TAR_END
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
