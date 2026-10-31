// Directory listing shapes shared by the file browser API and UI.

/** What the file browser works on: a container's filesystem or a volume. */
export type FileTarget = { kind: "container"; id: string } | { kind: "volume"; name: string }

/** Query string naming a target (?container=<id> or ?volume=<name>). */
export function targetQuery(target: FileTarget): URLSearchParams {
  return new URLSearchParams(target.kind === "container" ? { container: target.id } : { volume: target.name })
}

export type FileType = "dir" | "file" | "symlink" | "other"

export type FileEntry = {
  name: string
  type: FileType
  /** Bytes (for symlinks: length of the target, as stat reports it). */
  size: number
  /** Permission bits including setuid/setgid/sticky (mode & 0o7777). */
  mode: number
  uid: number
  gid: number
  /** Owner names when the container could resolve them (exec listing only). */
  user?: string
  group?: string
  /** Modification time, seconds since the epoch. */
  mtime: number
  /** Symbolic links: where the link points, as stored in the link. */
  linkTarget?: string
  /** For "other": fifo, socket, char device, block device; "hardlink" for archive hard links. */
  kind?: string
}

export type Listing = {
  path: string
  entries: FileEntry[]
  /** "exec": `stat` in the running container; "archive": headers of Docker's tar archive. */
  source: "exec" | "archive"
  /** Set when the listing is incomplete, with the reason. */
  truncated?: string
}

// File type bits of st_mode (S_IFMT).
const S_IFMT = 0o170000
const TYPES: Record<number, { type: FileType; kind?: string; char: string }> = {
  0o040000: { type: "dir", char: "d" },
  0o100000: { type: "file", char: "-" },
  0o120000: { type: "symlink", char: "l" },
  0o010000: { type: "other", kind: "fifo", char: "p" },
  0o140000: { type: "other", kind: "socket", char: "s" },
  0o020000: { type: "other", kind: "char device", char: "c" },
  0o060000: { type: "other", kind: "block device", char: "b" },
}

/** Type of a raw st_mode (as `stat -c %f` prints it, in hex). */
export function typeFromRawMode(raw: number): { type: FileType; kind?: string } {
  const t = TYPES[raw & S_IFMT]
  return t ? { type: t.type, kind: t.kind } : { type: "other" }
}

/** "drwxr-xr-x"-style permissions, like ls -l. */
export function formatMode(entry: Pick<FileEntry, "type" | "mode" | "kind">): string {
  const typeChar =
    entry.type === "dir"
      ? "d"
      : entry.type === "symlink"
        ? "l"
        : entry.type === "file"
          ? "-"
          : (Object.values(TYPES).find((t) => t.kind === entry.kind)?.char ?? "?")
  const m = entry.mode
  const triplet = (shift: number, special: boolean, specialChar: string) => {
    const r = m & (4 << shift) ? "r" : "-"
    const w = m & (2 << shift) ? "w" : "-"
    const xBit = Boolean(m & (1 << shift))
    const x = special ? (xBit ? specialChar : specialChar.toUpperCase()) : xBit ? "x" : "-"
    return r + w + x
  }
  return (
    typeChar +
    triplet(6, Boolean(m & 0o4000), "s") +
    triplet(3, Boolean(m & 0o2000), "s") +
    triplet(0, Boolean(m & 0o1000), "t")
  )
}

/** Folders first, then by name (byte order, like `ls` in the C locale). */
export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const da = a.type === "dir" ? 0 : 1
    const db = b.type === "dir" ? 0 : 1
    if (da !== db) return da - db
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

/**
 * Whether file content looks binary: a NUL byte in the first 8 KB, or bytes
 * that aren't valid UTF-8. Text editing is offered only for the rest.
 */
export function looksBinary(data: Uint8Array): boolean {
  const head = data.subarray(0, 8192)
  if (head.includes(0)) return true
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data)
    return false
  } catch {
    return true
  }
}
