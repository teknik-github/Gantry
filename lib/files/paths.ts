// Path handling for the file browser (containers and volumes). Shared by the
// server (validation) and the browser (breadcrumbs, links), so no server
// imports here. Paths are POSIX and absolute; for a volume "/" is the root
// of the volume.

export const MAX_PATH_LENGTH = 4096
export const MAX_NAME_BYTES = 255

export class PathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathError"
  }
}

/**
 * Normalizes a path: makes it absolute, collapses "//" and ".", resolves
 * ".." lexically. Refuses NUL bytes, overlong paths and ".." above the root
 * (unless `clamp`, which stops at the root like the kernel does, for
 * resolving symbolic link targets).
 */
export function normalizePath(input: unknown, opts: { clamp?: boolean } = {}): string {
  if (typeof input !== "string") throw new PathError("Path is required")
  if (input.includes("\0")) throw new PathError("Path contains a NUL byte")
  if (input.length > MAX_PATH_LENGTH) throw new PathError("Path is too long")
  const parts: string[] = []
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (!parts.length) {
        if (opts.clamp) continue
        throw new PathError("Path goes above the root")
      }
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join("/")}`
}

/** Why `name` can't be a single file or folder name, or null when it can. */
export function nameError(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) return "Name is required"
  if (name === "." || name === "..") return "Name can't be . or .."
  if (name.includes("/")) return "Name can't contain /"
  if (name.includes("\0")) return "Name can't contain a NUL byte"
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return `Name is longer than ${MAX_NAME_BYTES} bytes`
  return null
}

/** `dir`/`name` after validating `name` as one path component. */
export function joinPath(dir: string, name: string): string {
  const error = nameError(name)
  if (error) throw new PathError(error)
  return normalizePath(`${dir}/${name}`)
}

export function parentPath(path: string): string {
  const p = normalizePath(path)
  if (p === "/") return "/"
  return p.slice(0, p.lastIndexOf("/")) || "/"
}

export function baseName(path: string): string {
  const p = normalizePath(path)
  return p === "/" ? "" : p.slice(p.lastIndexOf("/") + 1)
}

/** Breadcrumb segments of a normalized path: [{ name: "etc", path: "/etc" }, ...]. */
export function pathSegments(path: string): { name: string; path: string }[] {
  const p = normalizePath(path)
  if (p === "/") return []
  let acc = ""
  return p
    .slice(1)
    .split("/")
    .map((name) => {
      acc += `/${name}`
      return { name, path: acc }
    })
}

/** Whether `path` is `root` or inside it (both normalized). */
export function isWithin(root: string, path: string): boolean {
  const r = normalizePath(root)
  const p = normalizePath(path)
  return r === "/" || p === r || p.startsWith(`${r}/`)
}

/** Where a symbolic link in `dir` points, as an absolute path (".." stops at the root). */
export function resolveLinkTarget(dir: string, target: string): string {
  return normalizePath(target.startsWith("/") ? target : `${dir}/${target}`, { clamp: true })
}

/** Maps a path shown to the user onto the path inside a container where it is mounted at `mount`. */
export function mountedPath(mount: string, path: string): string {
  const p = normalizePath(path)
  return p === "/" ? normalizePath(mount) : normalizePath(`${mount}${p}`)
}

/** The inverse of mountedPath: null when `inner` is outside the mount. */
export function unmountedPath(mount: string, inner: string): string | null {
  const m = normalizePath(mount)
  const p = normalizePath(inner, { clamp: true })
  if (p === m) return "/"
  return p.startsWith(`${m}/`) ? p.slice(m.length) : null
}
