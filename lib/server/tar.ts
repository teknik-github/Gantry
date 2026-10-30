import "server-only"

/**
 * A tar archive (ustar) holding one regular file, for Docker's
 * PUT /containers/{id}/archive. Names must be short (< 100 bytes).
 */
export function singleFileTar(name: string, content: string | Buffer, mode = 0o644): Buffer {
  const data = typeof content === "string" ? Buffer.from(content, "utf8") : content
  if (!/^[A-Za-z0-9._-]{1,99}$/.test(name)) throw new Error(`Unsupported tar entry name: ${name}`)
  const header = Buffer.alloc(512, 0)
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0") + "\0"
  header.write(name, 0, "utf8")
  header.write(octal(mode, 8), 100, "ascii")
  header.write(octal(0, 8), 108, "ascii") // uid
  header.write(octal(0, 8), 116, "ascii") // gid
  header.write(octal(data.length, 12), 124, "ascii")
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136, "ascii")
  header.write("        ", 148, "ascii") // checksum placeholder (spaces)
  header.write("0", 156, "ascii") // regular file
  header.write("ustar\0", 257, "ascii")
  header.write("00", 263, "ascii")
  let sum = 0
  for (const b of header) sum += b
  header.write(octal(sum, 7) + " ", 148, "ascii")
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512, 0)
  // Two zero blocks end the archive.
  return Buffer.concat([header, data, padding, Buffer.alloc(1024, 0)])
}
