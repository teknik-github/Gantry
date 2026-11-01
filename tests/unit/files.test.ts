import { describe, expect, it } from "vitest"

import { formatMode, looksBinary, sortEntries, typeFromRawMode, type FileEntry } from "@/lib/files/entries"
import {
  baseName,
  isWithin,
  joinPath,
  mountedPath,
  nameError,
  normalizePath,
  parentPath,
  pathSegments,
  PathError,
  resolveLinkTarget,
  unmountedPath,
} from "@/lib/files/paths"
import { FrameDemuxer } from "@/lib/server/docker/stream"
import { listCommand, parseStatOutput, STAT_FORMAT } from "@/lib/server/files/exec-list"
import { DirectoryCollector, parseNumeric, parsePax, TarError, TarReader, type TarEntry } from "@/lib/server/files/tar-read"
import { directoryTar, fileTarLength, fileTarStream, tarHeader, TAR_END } from "@/lib/server/tar"

describe("paths", () => {
  it("normalizes to absolute paths", () => {
    expect(normalizePath("/")).toBe("/")
    expect(normalizePath("")).toBe("/")
    expect(normalizePath("etc")).toBe("/etc")
    expect(normalizePath("//etc///ssl/./certs/")).toBe("/etc/ssl/certs")
    expect(normalizePath("/usr/local/../bin")).toBe("/usr/bin")
    expect(normalizePath("/a b/ü")).toBe("/a b/ü")
  })

  it("refuses escaping the root, NUL bytes, overlong paths and non-strings", () => {
    expect(() => normalizePath("/..")).toThrow(PathError)
    expect(() => normalizePath("/etc/../../x")).toThrow(/above the root/)
    expect(() => normalizePath("/etc/\0passwd")).toThrow(/NUL/)
    expect(() => normalizePath(`/${"a".repeat(5000)}`)).toThrow(/too long/)
    expect(() => normalizePath(undefined)).toThrow(PathError)
    expect(() => normalizePath(42)).toThrow(PathError)
  })

  it("clamps at the root when resolving link targets", () => {
    expect(normalizePath("/../../etc", { clamp: true })).toBe("/etc")
    expect(resolveLinkTarget("/srv", "a")).toBe("/srv/a")
    expect(resolveLinkTarget("/srv/x", "../y")).toBe("/srv/y")
    expect(resolveLinkTarget("/srv", "/etc/passwd")).toBe("/etc/passwd")
    expect(resolveLinkTarget("/", "../../etc")).toBe("/etc")
  })

  it("validates single names", () => {
    expect(nameError("file.txt")).toBeNull()
    expect(nameError("with space & ünïcode")).toBeNull()
    expect(nameError("")).toMatch(/required/)
    expect(nameError(".")).toMatch(/\.\./)
    expect(nameError("..")).toMatch(/\.\./)
    expect(nameError("a/b")).toMatch(/\//)
    expect(nameError("a\0b")).toMatch(/NUL/)
    expect(nameError("é".repeat(128))).toMatch(/255 bytes/)
    expect(nameError(null)).toMatch(/required/)
  })

  it("joins, splits and compares", () => {
    expect(joinPath("/", "etc")).toBe("/etc")
    expect(joinPath("/etc", "hosts")).toBe("/etc/hosts")
    expect(() => joinPath("/etc", "../root")).toThrow(PathError)
    expect(() => joinPath("/etc", "..")).toThrow(PathError)
    expect(parentPath("/")).toBe("/")
    expect(parentPath("/etc")).toBe("/")
    expect(parentPath("/etc/ssl/certs")).toBe("/etc/ssl")
    expect(baseName("/")).toBe("")
    expect(baseName("/etc/hosts")).toBe("hosts")
    expect(pathSegments("/")).toEqual([])
    expect(pathSegments("/etc/ssl")).toEqual([
      { name: "etc", path: "/etc" },
      { name: "ssl", path: "/etc/ssl" },
    ])
    expect(isWithin("/data", "/data")).toBe(true)
    expect(isWithin("/data", "/data/x")).toBe(true)
    expect(isWithin("/data", "/database")).toBe(false)
    expect(isWithin("/", "/anything")).toBe(true)
  })

  it("maps volume paths onto the helper's mount and back", () => {
    expect(mountedPath("/gantry-volume", "/")).toBe("/gantry-volume")
    expect(mountedPath("/gantry-volume", "/a/b")).toBe("/gantry-volume/a/b")
    expect(unmountedPath("/gantry-volume", "/gantry-volume")).toBe("/")
    expect(unmountedPath("/gantry-volume", "/gantry-volume/a")).toBe("/a")
    expect(unmountedPath("/gantry-volume", "/gantry-volume/../etc")).toBeNull()
    expect(unmountedPath("/gantry-volume", "/gantry-volumes/x")).toBeNull()
    expect(unmountedPath("/gantry-volume", "/etc/passwd")).toBeNull()
  })
})

describe("entries", () => {
  it("formats modes like ls", () => {
    expect(formatMode({ type: "dir", mode: 0o755 })).toBe("drwxr-xr-x")
    expect(formatMode({ type: "file", mode: 0o644 })).toBe("-rw-r--r--")
    expect(formatMode({ type: "symlink", mode: 0o777 })).toBe("lrwxrwxrwx")
    expect(formatMode({ type: "file", mode: 0o4755 })).toBe("-rwsr-xr-x")
    expect(formatMode({ type: "file", mode: 0o2644 })).toBe("-rw-r-Sr--")
    expect(formatMode({ type: "dir", mode: 0o1777 })).toBe("drwxrwxrwt")
    expect(formatMode({ type: "other", kind: "fifo", mode: 0o600 })).toBe("prw-------")
  })

  it("reads the file type from a raw st_mode", () => {
    expect(typeFromRawMode(0x41ed)).toEqual({ type: "dir", kind: undefined })
    expect(typeFromRawMode(0x81a4)).toEqual({ type: "file", kind: undefined })
    expect(typeFromRawMode(0xa1ff)).toEqual({ type: "symlink", kind: undefined })
    expect(typeFromRawMode(0x21b6)).toEqual({ type: "other", kind: "char device" })
  })

  it("sorts folders first, then by name", () => {
    const e = (name: string, type: FileEntry["type"]): FileEntry => ({ name, type, size: 0, mode: 0, uid: 0, gid: 0, mtime: 0 })
    expect(sortEntries([e("b", "file"), e("z", "dir"), e("a", "symlink"), e("c", "dir")]).map((x) => x.name)).toEqual([
      "c",
      "z",
      "a",
      "b",
    ])
  })

  it("tells text from binary", () => {
    expect(looksBinary(Buffer.from("hello\nwörld\n"))).toBe(false)
    expect(looksBinary(Buffer.from(""))).toBe(false)
    expect(looksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true)
    expect(looksBinary(Buffer.from([0xff, 0xfe, 0x41]))).toBe(true)
  })
})

/** A ustar header block built by hand (to test what our writer never emits). */
function header(fields: { name: string; size?: number | Buffer; type?: string; prefix?: string; link?: string; mode?: number; gnu?: boolean }) {
  const h = Buffer.alloc(512, 0)
  h.write(fields.name, 0, 100, "utf8")
  h.write("0000644\0", 100, "ascii")
  h.write("0001750\0", 108, "ascii") // uid 1000
  h.write("0001750\0", 116, "ascii")
  if (Buffer.isBuffer(fields.size)) fields.size.copy(h, 124)
  else h.write((fields.size ?? 0).toString(8).padStart(11, "0") + "\0", 124, "ascii")
  h.write("14576330760\0", 136, "ascii")
  h.write(fields.type ?? "0", 156, "ascii")
  if (fields.link) h.write(fields.link, 157, 100, "utf8")
  if (fields.gnu) h.write("ustar  \0", 257, "ascii")
  else {
    h.write("ustar\0", 257, "ascii")
    h.write("00", 263, "ascii")
  }
  if (fields.prefix) h.write(fields.prefix, 345, 155, "utf8")
  h.write("        ", 148, "ascii")
  let sum = 0
  for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii")
  return h
}

const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512, 0)

function readAll(archive: Buffer, chunkSize = archive.length) {
  const entries: TarEntry[] = []
  const data = new Map<string, Buffer[]>()
  const reader = new TarReader({
    onEntry: (e) => void entries.push(e),
    onData: (chunk, e) => data.set(e.name, [...(data.get(e.name) ?? []), Buffer.from(chunk)]),
  })
  for (let i = 0; i < archive.length; i += chunkSize) reader.push(archive.subarray(i, i + chunkSize))
  return { entries, reader, body: (name: string) => Buffer.concat(data.get(name) ?? []).toString() }
}

describe("tar reader", () => {
  const archive = Buffer.concat([
    tarHeader({ name: "etc", type: "dir", mtime: 1700000000 }),
    tarHeader({ name: "etc/hosts", type: "file", size: 10, mode: 0o640, uid: 3, gid: 4, mtime: 1700000001 }),
    Buffer.from("127.0.0.1\n"),
    pad(10),
    tarHeader({ name: `etc/${"long-name-".repeat(15)}.conf`, type: "file", size: 600 }),
    Buffer.alloc(600, 0x61),
    pad(600),
    tarHeader({ name: "etc/ünïcode", type: "file", size: 0 }),
    TAR_END,
  ])

  it("reads names, types, owners and bodies, in any chunking", () => {
    for (const chunkSize of [archive.length, 512, 100, 7, 1]) {
      const { entries, reader, body } = readAll(archive, chunkSize)
      expect(entries.map((e) => [e.name, e.type])).toEqual([
        ["etc/", "dir"],
        ["etc/hosts", "file"],
        [`etc/${"long-name-".repeat(15)}.conf`, "file"],
        ["etc/ünïcode", "file"],
      ])
      expect(entries[1]).toMatchObject({ size: 10, mode: 0o640, uid: 3, gid: 4, mtime: 1700000001 })
      expect(body("etc/hosts")).toBe("127.0.0.1\n")
      expect(body(`etc/${"long-name-".repeat(15)}.conf`)).toBe("a".repeat(600))
      expect(reader.done).toBe(true)
      expect(reader.bytes).toBe(archive.length)
    }
  })

  it("understands the ustar prefix, GNU long names, links and base-256 sizes", () => {
    const longName = `deep/${"x".repeat(150)}`
    const base256 = Buffer.alloc(12, 0)
    base256[0] = 0x80
    base256.writeUInt32BE(1024, 8)
    const gnuName = Buffer.from(`${longName}\0`)
    const tar = Buffer.concat([
      header({ name: "file", prefix: "usr/share/doc", size: 0 }),
      header({ name: "././@LongLink", type: "L", size: gnuName.length, gnu: true }),
      gnuName,
      pad(gnuName.length),
      header({ name: "truncated-name", size: 0, gnu: true }),
      header({ name: "bin/sh", type: "2", link: "/bin/busybox" }),
      header({ name: "bin/ash", type: "1", link: "bin/busybox" }),
      header({ name: "big", size: base256 }),
      Buffer.alloc(1024, 0x62),
      TAR_END,
    ])
    const { entries } = readAll(tar, 33)
    expect(entries.map((e) => e.name)).toEqual(["usr/share/doc/file", longName, "bin/sh", "bin/ash", "big"])
    expect(entries[2]).toMatchObject({ type: "symlink", linkname: "/bin/busybox", size: 0 })
    expect(entries[3]).toMatchObject({ type: "file", kind: "hardlink", linkname: "bin/busybox" })
    expect(entries[4]).toMatchObject({ size: 1024, uid: 1000 })
  })

  it("parses numbers and PAX records", () => {
    expect(parseNumeric(Buffer.from("0000755\0"), 0, 8)).toBe(0o755)
    expect(parseNumeric(Buffer.from("  644 \0"), 0, 7)).toBe(0o644)
    expect(parsePax(Buffer.from("20 path=a/very/long\n13 mtime=1.5\n"))).toEqual({ path: "a/very/long", mtime: "1.5" })
  })

  it("rejects corrupt headers", () => {
    const bad = Buffer.from(tarHeader({ name: "x", type: "file", size: 0 }))
    bad[0] = 0x79
    const reader = new TarReader({ onEntry: () => {} })
    expect(() => reader.push(bad)).toThrow(TarError)
  })

  it("stops when a handler asks to", () => {
    let seen = 0
    const reader = new TarReader({ onEntry: () => (++seen === 2 ? "stop" : undefined) })
    expect(reader.push(archive)).toBe(false)
    expect(seen).toBe(2)
  })
})

describe("directory collector", () => {
  const entry = (name: string, type: FileEntry["type"] = "file", extra: Partial<TarEntry> = {}): TarEntry => ({
    name,
    typeflag: type === "dir" ? "5" : type === "symlink" ? "2" : "0",
    type,
    size: 5,
    mode: 0o644,
    uid: 0,
    gid: 0,
    uname: "",
    gname: "",
    mtime: 1,
    linkname: "",
    ...extra,
  })

  it("keeps only direct children of the archived folder", () => {
    const c = new DirectoryCollector(100)
    for (const e of [
      entry("usr/", "dir"),
      entry("usr/bin/", "dir"),
      entry("usr/bin/ls"),
      entry("usr/lib/", "dir"),
      entry("usr/lib/deep/x.so"),
      entry("usr/local", "symlink", { linkname: "../opt" }),
      entry("usr/README"),
    ])
      c.add(e)
    expect(c.scan.self?.name).toBe("usr/")
    expect(c.scan.children.map((e) => [e.name, e.type, e.linkTarget])).toEqual([
      ["bin", "dir", undefined],
      ["lib", "dir", undefined],
      ["local", "symlink", "../opt"],
      ["README", "file", undefined],
    ])
    expect(c.scan.children.find((e) => e.name === "bin")?.size).toBe(0)
  })

  it("handles the root folder (names start with /) and caps entries", () => {
    const c = new DirectoryCollector(2)
    for (const e of [entry("/", "dir"), entry("/.dockerenv"), entry("/bin/", "dir"), entry("/bin/sh", "symlink"), entry("/etc/", "dir")]) c.add(e)
    expect(c.scan.children.map((e) => e.name)).toEqual([".dockerenv", "bin"])
    expect(c.scan.dropped).toBe(1)
  })
})

describe("tar writer", () => {
  it("writes a folder archive the reader understands", () => {
    const { entries, reader } = readAll(directoryTar("new folder"))
    expect(entries).toMatchObject([{ name: "new folder/", type: "dir", mode: 0o755, uid: 0 }])
    expect(reader.done).toBe(true)
  })

  it("streams one file with the exact length announced", async () => {
    const h = tarHeader({ name: "data.bin", type: "file", size: 700, mode: 0o600, uid: 1000, gid: 1000 })
    async function* body() {
      yield Buffer.alloc(300, 1)
      yield Buffer.alloc(400, 2)
    }
    const chunks: Buffer[] = []
    for await (const c of fileTarStream(h, 700, body())) chunks.push(c)
    const tar = Buffer.concat(chunks)
    expect(tar.length).toBe(fileTarLength(h, 700))
    const { entries, body: read } = readAll(tar, 64)
    expect(entries).toMatchObject([{ name: "data.bin", size: 700, mode: 0o600, uid: 1000, gid: 1000 }])
    expect(read("data.bin").length).toBe(700)
  })

  it("refuses bodies that don't match the announced size", async () => {
    const h = tarHeader({ name: "x", type: "file", size: 3 })
    async function* tooLong() {
      yield Buffer.from("abcd")
    }
    async function* tooShort() {
      yield Buffer.from("ab")
    }
    const drain = async (it: AsyncIterable<Buffer>) => {
      for await (const _ of it) void _
    }
    await expect(drain(fileTarStream(h, 3, tooLong()))).rejects.toThrow(/larger/)
    await expect(drain(fileTarStream(h, 3, tooShort()))).rejects.toThrow(/ended early/)
  })

  it("gets PAX record lengths right around powers of ten", () => {
    for (let n = 80; n < 1100; n += 1) {
      const name = "d".repeat(n)
      expect(readAll(Buffer.concat([tarHeader({ name, type: "file", size: 0 }), TAR_END])).entries[0].name).toBe(name)
    }
  })

  it("uses a PAX header for long and non-ASCII names", () => {
    const name = `ü-${"n".repeat(120)}`
    const h = tarHeader({ name, type: "file", size: 0 })
    expect(h.length).toBe(512 * 3)
    expect(readAll(Buffer.concat([h, TAR_END])).entries[0].name).toBe(name)
  })
})

describe("exec listing", () => {
  const FS = "\x1f"
  const rec = (...f: string[]) => f.join(FS) + "\x1e\n"

  it("builds a stat command that passes the folder as an argument", () => {
    const cmd = listCommand("/a b; rm -rf /")
    expect(cmd.slice(0, 2)).toEqual(["sh", "-c"])
    expect(cmd[4]).toBe("/a b; rm -rf /")
    expect(cmd[5]).toBe(STAT_FORMAT)
  })

  it("parses busybox and GNU stat output, including link targets", () => {
    const out =
      rec("81a4", "6", "0", "0", "root", "root", "1793428429", "./a b", "./a b") +
      rec("a1ff", "11", "0", "0", "root", "root", "1793428429", "./lnk x", "'./lnk x' -> '/etc/passwd'") +
      rec("a1ff", "7", "0", "0", "root", "root", "1793428429", "./dangling", "./dangling -> nowhere") +
      rec("41ed", "4096", "1000", "1000", "UNKNOWN", "UNKNOWN", "1793428429", "./sub", "./sub") +
      rec("81a4", "0", "0", "0", "root", "root", "1", ".hid", ".hid") +
      "garbage line\n"
    const entries = parseStatOutput(out)
    expect(entries.map((e) => [e.name, e.type, e.linkTarget])).toEqual([
      ["a b", "file", undefined],
      ["lnk x", "symlink", "/etc/passwd"],
      ["dangling", "symlink", "nowhere"],
      ["sub", "dir", undefined],
      [".hid", "file", undefined],
    ])
    expect(entries[0]).toMatchObject({ size: 6, mode: 0o644, user: "root", mtime: 1793428429 })
    expect(entries[3]).toMatchObject({ uid: 1000, user: undefined, mode: 0o755 })
  })
})

describe("frame demuxer", () => {
  const frame = (stream: number, text: string) => {
    const payload = Buffer.from(text)
    const h = Buffer.alloc(8)
    h[0] = stream
    h.writeUInt32BE(payload.length, 4)
    return Buffer.concat([h, payload])
  }

  it("splits stdout and stderr across arbitrary chunks", () => {
    const data = Buffer.concat([frame(1, "out one\n"), frame(2, "err\n"), frame(1, "out two\n")])
    for (const size of [data.length, 9, 3, 1]) {
      const got: Record<number, string> = { 1: "", 2: "" }
      const d = new FrameDemuxer((s, p) => (got[s] += p.toString()))
      for (let i = 0; i < data.length; i += size) d.push(data.subarray(i, i + size))
      expect(got).toEqual({ 1: "out one\nout two\n", 2: "err\n" })
    }
  })

  it("rejects data that isn't multiplexed", () => {
    const d = new FrameDemuxer(() => {})
    expect(() => d.push(Buffer.from("plain text output"))).toThrow()
  })
})
