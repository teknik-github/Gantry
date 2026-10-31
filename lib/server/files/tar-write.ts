import "server-only"

/**
 * Tar headers for Docker's PUT /containers/{id}/archive: one regular file
 * (streamed body) or one directory. Names that don't fit ustar's 100 bytes
 * or aren't ASCII get a PAX extended header, which Docker understands.
 */

const BLOCK = 512

export type TarHeaderInput = {
  name: string
  type: "file" | "dir"
  size?: number
  mode?: number
  uid?: number
  gid?: number
  /** Seconds since the epoch (default: now). */
  mtime?: number
}

const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0") + "\0"

function rawHeader(name: string, typeflag: string, size: number, mode: number, uid: number, gid: number, mtime: number) {
  const header = Buffer.alloc(BLOCK, 0)
  header.write(name, 0, 100, "utf8")
  header.write(octal(mode & 0o7777, 8), 100, "ascii")
  header.write(octal(uid, 8), 108, "ascii")
  header.write(octal(gid, 8), 116, "ascii")
  header.write(octal(size, 12), 124, "ascii")
  header.write(octal(mtime, 12), 136, "ascii")
  header.write("        ", 148, "ascii") // checksum placeholder
  header.write(typeflag, 156, "ascii")
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

/** Header block(s) for one entry: PAX header first when needed, then ustar. */
export function tarHeader(input: TarHeaderInput): Buffer {
  const mtime = Math.floor(input.mtime ?? Date.now() / 1000)
  const size = input.type === "file" ? (input.size ?? 0) : 0
  const name = input.type === "dir" ? `${input.name.replace(/\/+$/, "")}/` : input.name
  const mode = input.mode ?? (input.type === "dir" ? 0o755 : 0o644)
  const uid = input.uid ?? 0
  const gid = input.gid ?? 0

  const records: string[] = []
  const ascii = /^[\x20-\x7e]*$/.test(name)
  if (!ascii || Buffer.byteLength(name) > 99) records.push(paxRecord("path", name))
  if (size > MAX_OCTAL_SIZE) records.push(paxRecord("size", String(size)))
  const main = rawHeader(
    ascii && Buffer.byteLength(name) <= 99 ? name : name.replace(/[^\x20-\x7e]/g, "_").slice(-99),
    input.type === "dir" ? "5" : "0",
    size > MAX_OCTAL_SIZE ? 0 : size,
    mode,
    uid,
    gid,
    mtime
  )
  if (!records.length) return main
  const pax = Buffer.from(records.join(""), "utf8")
  const paxHeader = rawHeader("PaxHeader", "x", pax.length, 0o644, 0, 0, mtime)
  return Buffer.concat([paxHeader, pax, Buffer.alloc(padding(pax.length), 0), main])
}

export function padding(size: number) {
  return (BLOCK - (size % BLOCK)) % BLOCK
}

/** Two zero blocks end an archive. */
export const TAR_END = Buffer.alloc(BLOCK * 2, 0)

/** A complete archive holding one directory. */
export function directoryTar(name: string, opts: Omit<TarHeaderInput, "name" | "type" | "size"> = {}): Buffer {
  return Buffer.concat([tarHeader({ ...opts, name, type: "dir" }), TAR_END])
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
