import "server-only"

import type { FileEntry } from "@/lib/files/entries"

/**
 * Incremental tar reader for Docker's archive API (GET
 * /containers/{id}/archive). It reads headers only: file bodies are skipped
 * as they stream past (or handed to `onData` when extracting one file), so a
 * listing never holds more than one 512-byte block plus extended headers in
 * memory. Understands ustar (with the name prefix), PAX extended headers
 * (long names, big sizes) and GNU long names, which Go's archive/tar emits.
 */

export class TarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TarError"
  }
}

export type TarEntry = {
  name: string
  /** "0" file, "1" hard link, "2" symlink, "5" dir, ... */
  typeflag: string
  type: FileEntry["type"]
  kind?: string
  size: number
  mode: number
  uid: number
  gid: number
  uname: string
  gname: string
  mtime: number
  linkname: string
}

type Handlers = {
  /** Return "stop" to stop parsing (the caller then closes the stream). */
  onEntry(entry: TarEntry): void | "stop"
  /** Body bytes of the current entry (omit to skip bodies). */
  onData?(chunk: Buffer, entry: TarEntry): void
}

/** Largest PAX/GNU extended header we accept (real ones are a few hundred bytes). */
const MAX_META_BYTES = 1024 * 1024
const BLOCK = 512

const pad = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK

function cString(buf: Buffer, start: number, length: number) {
  const slice = buf.subarray(start, start + length)
  const end = slice.indexOf(0)
  return (end === -1 ? slice : slice.subarray(0, end)).toString("utf8")
}

/** Octal (NUL/space terminated) or GNU base-256 numeric field. */
export function parseNumeric(buf: Buffer, start: number, length: number): number {
  const field = buf.subarray(start, start + length)
  if (field[0] & 0x80) {
    // Base-256: big-endian two's complement, first byte's top bit is the marker.
    let value = field[0] & 0x7f
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]
    return value
  }
  const text = cString(buf, start, length).trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) throw new TarError("Invalid tar header (bad number)")
  return parseInt(text, 8)
}

function checksumOk(block: Buffer) {
  const stored = parseNumeric(block, 148, 8)
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]
  return sum === stored
}

/** PAX records: "<len> <key>=<value>\n", len counting the whole record. */
export function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const len = Number(data.subarray(offset, space).toString("ascii"))
    if (!Number.isSafeInteger(len) || len <= 0 || offset + len > data.length) break
    const record = data.subarray(space + 1, offset + len - 1).toString("utf8")
    const eq = record.indexOf("=")
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    offset += len
  }
  return out
}

const TYPEFLAGS: Record<string, { type: FileEntry["type"]; kind?: string }> = {
  "0": { type: "file" },
  "\0": { type: "file" },
  "": { type: "file" },
  "7": { type: "file" },
  "1": { type: "file", kind: "hardlink" },
  "2": { type: "symlink" },
  "3": { type: "other", kind: "char device" },
  "4": { type: "other", kind: "block device" },
  "5": { type: "dir" },
  "6": { type: "other", kind: "fifo" },
}

export class TarReader {
  private header = Buffer.alloc(BLOCK)
  private headerFill = 0
  /** Bytes of the current body still to skip/forward, then padding. */
  private bodyLeft = 0
  private padLeft = 0
  private current: TarEntry | null = null
  /** Collecting an extended header body. */
  private meta: { kind: "pax" | "gnu-name" | "gnu-link" | "global"; chunks: Buffer[]; left: number; pad: number } | null = null
  private pax: Record<string, string> = {}
  private longName: string | null = null
  private longLink: string | null = null
  private zeroBlocks = 0
  /** Total bytes consumed so far. */
  bytes = 0
  entries = 0
  done = false

  constructor(private handlers: Handlers) {}

  /** Feeds the next chunk; returns false once the archive ended or a handler stopped it. */
  push(chunk: Buffer): boolean {
    let offset = 0
    while (offset < chunk.length && !this.done) {
      if (this.meta) {
        const m = this.meta
        if (m.left > 0) {
          const n = Math.min(m.left, chunk.length - offset)
          m.chunks.push(chunk.subarray(offset, offset + n))
          m.left -= n
          offset += n
          this.bytes += n
          continue
        }
        if (m.pad > 0) {
          const n = Math.min(m.pad, chunk.length - offset)
          m.pad -= n
          offset += n
          this.bytes += n
          continue
        }
        this.finishMeta()
        continue
      }
      if (this.bodyLeft > 0) {
        const n = Math.min(this.bodyLeft, chunk.length - offset)
        if (this.handlers.onData && this.current) this.handlers.onData(chunk.subarray(offset, offset + n), this.current)
        this.bodyLeft -= n
        offset += n
        this.bytes += n
        continue
      }
      if (this.padLeft > 0) {
        const n = Math.min(this.padLeft, chunk.length - offset)
        this.padLeft -= n
        offset += n
        this.bytes += n
        continue
      }
      const n = Math.min(BLOCK - this.headerFill, chunk.length - offset)
      chunk.copy(this.header, this.headerFill, offset, offset + n)
      this.headerFill += n
      offset += n
      this.bytes += n
      if (this.headerFill === BLOCK) {
        this.headerFill = 0
        this.readHeader(this.header)
      }
    }
    // An extended header that ends exactly at the chunk boundary.
    if (this.meta && this.meta.left === 0 && this.meta.pad === 0) this.finishMeta()
    return !this.done
  }

  private finishMeta() {
    const m = this.meta!
    this.meta = null
    const data = Buffer.concat(m.chunks)
    if (m.kind === "pax") this.pax = { ...this.pax, ...parsePax(data) }
    else if (m.kind === "gnu-name") this.longName = cString(data, 0, data.length)
    else if (m.kind === "gnu-link") this.longLink = cString(data, 0, data.length)
    // Global PAX headers carry nothing a listing needs.
  }

  private readHeader(block: Buffer) {
    if (block.every((b) => b === 0)) {
      if (++this.zeroBlocks >= 2) this.done = true
      return
    }
    this.zeroBlocks = 0
    if (!checksumOk(block)) throw new TarError("Invalid tar header (checksum)")

    const typeflag = String.fromCharCode(block[156]).replace("\0", "0")
    const size = parseNumeric(block, 124, 12)
    const metaKind =
      typeflag === "x" ? "pax" : typeflag === "g" ? "global" : typeflag === "L" ? "gnu-name" : typeflag === "K" ? "gnu-link" : null
    if (metaKind) {
      if (size > MAX_META_BYTES) throw new TarError("Tar extended header too large")
      this.meta = { kind: metaKind, chunks: [], left: size, pad: pad(size) }
      return
    }

    const magic = block.subarray(257, 263).toString("latin1")
    const prefix = magic === "ustar\u000000" || magic.startsWith("ustar\0") ? cString(block, 345, 155) : ""
    let name = cString(block, 0, 100)
    if (prefix) name = `${prefix}/${name}`
    let linkname = cString(block, 157, 100)
    let entrySize = size
    let mtime = parseNumeric(block, 136, 12)
    let uid = parseNumeric(block, 108, 8)
    let gid = parseNumeric(block, 116, 8)
    let uname = cString(block, 265, 32)
    let gname = cString(block, 297, 32)

    if (this.longName !== null) name = this.longName
    if (this.longLink !== null) linkname = this.longLink
    const pax = this.pax
    if (pax.path !== undefined) name = pax.path
    if (pax.linkpath !== undefined) linkname = pax.linkpath
    if (pax.size !== undefined && /^\d+$/.test(pax.size)) entrySize = Number(pax.size)
    if (pax.mtime !== undefined && Number.isFinite(Number(pax.mtime))) mtime = Math.floor(Number(pax.mtime))
    if (pax.uid !== undefined && /^\d+$/.test(pax.uid)) uid = Number(pax.uid)
    if (pax.gid !== undefined && /^\d+$/.test(pax.gid)) gid = Number(pax.gid)
    if (pax.uname !== undefined) uname = pax.uname
    if (pax.gname !== undefined) gname = pax.gname
    this.pax = {}
    this.longName = null
    this.longLink = null

    const t = TYPEFLAGS[typeflag] ?? { type: "other" as const, kind: `type ${typeflag}` }
    // Only regular files carry a body; hard links, dirs, links have size 0 (or a meaningless one).
    const hasBody = typeflag === "0" || typeflag === "7" || !(typeflag in TYPEFLAGS)
    const entry: TarEntry = {
      name,
      typeflag,
      type: t.type,
      kind: t.kind,
      size: entrySize,
      mode: parseNumeric(block, 100, 8) & 0o7777,
      uid,
      gid,
      uname,
      gname,
      mtime,
      linkname,
    }
    this.entries++
    this.current = entry
    this.bodyLeft = hasBody ? entrySize : 0
    this.padLeft = hasBody ? pad(entrySize) : 0
    if (this.handlers.onEntry(entry) === "stop") this.done = true
  }
}

/** Entry name without leading "./" or "/" and trailing "/". */
function cleanName(name: string) {
  return name.replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "")
}

export type DirectoryScan = {
  /** The directory itself (first entry of the archive). */
  self: TarEntry | null
  children: FileEntry[]
  /** Children seen beyond `maxEntries` (not returned). */
  dropped: number
}

/**
 * Collects the direct children of the directory an archive was made of.
 * Docker names the entries after the directory's base name ("usr/",
 * "usr/bin/", "usr/bin/ls"; for "/" they start with "/"), depth first, so
 * every entry must be read to find them all: deeper entries are skipped.
 */
export class DirectoryCollector {
  private root: string | null = null
  readonly scan: DirectoryScan = { self: null, children: [], dropped: 0 }

  constructor(private maxEntries: number) {}

  add(entry: TarEntry) {
    const name = cleanName(entry.name)
    if (this.root === null) {
      this.root = name
      this.scan.self = entry
      return
    }
    let rel: string
    if (this.root === "") rel = name
    else if (name.startsWith(`${this.root}/`)) rel = name.slice(this.root.length + 1)
    else return
    if (!rel || rel.includes("/")) return
    if (this.scan.children.length >= this.maxEntries) {
      this.scan.dropped++
      return
    }
    this.scan.children.push({
      name: rel,
      type: entry.type,
      kind: entry.kind,
      size: entry.type === "file" ? entry.size : 0,
      mode: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      user: entry.uname || undefined,
      group: entry.gname || undefined,
      mtime: entry.mtime,
      linkTarget: entry.type === "symlink" || entry.kind === "hardlink" ? entry.linkname : undefined,
    })
  }
}
