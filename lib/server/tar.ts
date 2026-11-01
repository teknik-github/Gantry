import "server-only"

/**
 * Tar (ustar) writing for Docker's archive APIs: PUT /containers/{id}/archive
 * (the file browser, the proxy's Caddyfile, the scanner's input folders) and
 * POST /build contexts. Names or link targets that don't fit ustar's 100
 * bytes or aren't ASCII, and sizes past 8 GiB, get a PAX extended header,
 * which Docker understands. Reading is lib/server/files/tar-read.ts.
 */

const BLOCK = 512

export type TarHeaderInput = {
  name: string
  type: "file" | "dir" | "symlink"
  size?: number
  mode?: number
  uid?: number
  gid?: number
  /** Seconds since the epoch (default: now). */
  mtime?: number
  /** Target of a symlink. */
  linkname?: string
}

const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0") + "\0"

function rawHeader(
  name: string,
  typeflag: string,
  e: { size: number; mode: number; uid: number; gid: number; mtime: number; linkname?: string }
) {
  const header = Buffer.alloc(BLOCK, 0)
  header.write(name, 0, 100, "utf8")
  header.write(octal(e.mode & 0o7777, 8), 100, "ascii")
  header.write(octal(e.uid, 8), 108, "ascii")
  header.write(octal(e.gid, 8), 116, "ascii")
  header.write(octal(e.size, 12), 124, "ascii")
  header.write(octal(e.mtime, 12), 136, "ascii")
  header.write("        ", 148, "ascii") // checksum placeholder
  header.write(typeflag, 156, "ascii")
  if (e.linkname) header.write(e.linkname, 157, 100, "utf8")
  header.write("ustar\0", 257, "ascii")
  header.write("00", 263, "ascii")
  let sum = 0
  for (const b of header) sum += b
  header.write(octal(sum, 7) + " ", 148, "ascii")
  return header
}

/** One PAX record: "<len> <key>=<value>\n" where len counts the whole record. */
function paxRecord(key: string, value: string) {
  const body = ` ${key}=${value}\n`
  const bodyLen = Buffer.byteLength(body)
  // The length counts its own digits: one more digit if adding them crossed a power of ten.
  let len = bodyLen + String(bodyLen).length
  if (String(len).length !== String(bodyLen).length) len++
  return `${len}${body}`
}

const MAX_OCTAL_SIZE = 0o77777777777 // what 11 octal digits hold (8 GiB - 1)

/** Whether a name fits a ustar field as is (ASCII, room for the NUL). */
const fitsUstar = (s: string) => /^[\x20-\x7e]*$/.test(s) && Buffer.byteLength(s) <= 99

/** What goes in the ustar field when the real value is in the PAX header. */
const ustarFallback = (s: string) => s.replace(/[^\x20-\x7e]/g, "_").slice(-99)

/** Header block(s) for one entry: PAX header first when needed, then ustar. */
export function tarHeader(input: TarHeaderInput): Buffer {
  const mtime = Math.max(0, Math.floor(input.mtime ?? Date.now() / 1000))
  const size = input.type === "file" ? (input.size ?? 0) : 0
  const name = input.type === "dir" ? `${input.name.replace(/\/+$/, "")}/` : input.name
  const linkname = input.type === "symlink" ? (input.linkname ?? "") : ""
  const mode = input.mode ?? (input.type === "dir" ? 0o755 : input.type === "symlink" ? 0o777 : 0o644)
  const typeflag = input.type === "dir" ? "5" : input.type === "symlink" ? "2" : "0"

  const records: string[] = []
  if (!fitsUstar(name)) records.push(paxRecord("path", name))
  if (!fitsUstar(linkname)) records.push(paxRecord("linkpath", linkname))
  if (size > MAX_OCTAL_SIZE) records.push(paxRecord("size", String(size)))
  const main = rawHeader(fitsUstar(name) ? name : ustarFallback(name), typeflag, {
    size: size > MAX_OCTAL_SIZE ? 0 : size,
    mode,
    uid: input.uid ?? 0,
    gid: input.gid ?? 0,
    mtime,
    linkname: fitsUstar(linkname) ? linkname : ustarFallback(linkname),
  })
  if (!records.length) return main
  const pax = Buffer.from(records.join(""), "utf8")
  const paxHeader = rawHeader("PaxHeader", "x", { size: pax.length, mode: 0o644, uid: 0, gid: 0, mtime })
  return Buffer.concat([paxHeader, pax, Buffer.alloc(padding(pax.length), 0), main])
}

/** Zero bytes after a body of `size` bytes, up to the next block. */
export function padding(size: number) {
  return (BLOCK - (size % BLOCK)) % BLOCK
}

/** Two zero blocks end an archive. */
export const TAR_END = Buffer.alloc(BLOCK * 2, 0)

/** A complete archive of empty directories (e.g. "scan/", "scan/image/"). */
export function directoryTar(
  names: string | readonly string[],
  opts: Omit<TarHeaderInput, "name" | "type" | "size" | "linkname"> = {}
): Buffer {
  const list = typeof names === "string" ? [names] : names
  return Buffer.concat([...list.map((name) => tarHeader({ ...opts, name, type: "dir" })), TAR_END])
}

/**
 * A complete archive holding one regular file. Only plain file names (no
 * folders).
 */
export function singleFileTar(name: string, content: string | Buffer, mode = 0o644): Buffer {
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content
  if (!/^[A-Za-z0-9._-]{1,99}$/.test(name)) throw new Error(`Unsupported tar entry name: ${name}`)
  return Buffer.concat([
    tarHeader({ name, type: "file", size: data.length, mode }),
    data,
    Buffer.alloc(padding(data.length), 0),
    TAR_END,
  ])
}

/** Total archive size for one file of `size` bytes (for Content-Length). */
export function fileTarLength(header: Buffer, size: number) {
  return header.length + size + padding(size) + TAR_END.length
}

/**
 * The archive for one file whose body arrives as a stream: header, the
 * body bytes (exactly `size` of them, or it throws), padding, end blocks.
 */
export async function* fileTarStream(
  header: Buffer,
  size: number,
  body: AsyncIterable<Uint8Array>
): AsyncGenerator<Buffer> {
  yield header
  let received = 0
  for await (const chunk of body) {
    received += chunk.length
    if (received > size) throw new Error("The upload is larger than announced")
    yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  if (received !== size) throw new Error("The upload ended early")
  yield Buffer.concat([Buffer.alloc(padding(size), 0), TAR_END])
}
