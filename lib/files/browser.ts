// Pure helpers of the file browser UI (components/gantry/file-browser*.tsx).

import type { FileEntry, FileTarget } from "@/lib/files/entries"
import { parentPath, resolveLinkTarget } from "@/lib/files/paths"

/** "user:group" (names when the listing has them, else the ids). */
export function entryOwner(e: Pick<FileEntry, "user" | "uid" | "group" | "gid">): string {
  return `${e.user ?? e.uid}:${e.group ?? e.gid}`
}

/**
 * Where a symbolic link in `dir` leads, when the browser can follow it; null
 * for anything else. In a volume, absolute links point into whatever
 * container mounts it, so they aren't followable.
 */
export function followableLink(target: FileTarget, dir: string, e: Pick<FileEntry, "type" | "linkTarget">): string | null {
  if (e.type !== "symlink" || !e.linkTarget) return null
  if (target.kind === "volume" && e.linkTarget.startsWith("/")) return null
  return resolveLinkTarget(dir, e.linkTarget)
}

type TypeLabels = { other: string; hardlink: string; folder: string; file: string; symlink: string }

/** The Type column: the special file's kind, "hard link", "folder", "file" or "symbolic link". */
export function entryTypeLabel(e: Pick<FileEntry, "type" | "kind">, types: TypeLabels): string {
  if (e.type === "other") return e.kind ?? types.other
  if (e.kind === "hardlink") return types.hardlink
  if (e.type === "dir") return types.folder
  return types[e.type]
}

/** Names of `files` that already exist among `entries`. */
export function existingNames(files: readonly { name: string }[], entries: readonly { name: string }[] | undefined): string[] {
  const names = new Set(entries?.map((e) => e.name))
  return files.filter((f) => names.has(f.name)).map((f) => f.name)
}

/** `files` without those named in `skip`. */
export function withoutNames<F extends { name: string }>(files: readonly F[], skip: readonly string[]): F[] {
  const set = new Set(skip)
  return files.filter((f) => !set.has(f.name))
}

/** Directory and name of an absolute file path ("/etc/hosts" → "/etc", "hosts"). */
export function splitFilePath(filePath: string): { dir: string; name: string } {
  const dir = parentPath(filePath)
  return { dir, name: filePath.slice(dir === "/" ? 1 : dir.length + 1) }
}

/**
 * PUT URL writing the file `name` into `dir` of the target (`query`, see
 * targetQuery). `edit` saves from the editor; `overwrite` replaces an
 * existing file.
 */
export function uploadUrl(
  query: string,
  dir: string,
  name: string,
  opts: { edit?: boolean; overwrite?: boolean; environmentId?: number }
): string {
  const params = new URLSearchParams(query)
  params.set("path", dir)
  params.set("name", name)
  if (opts.edit) params.set("mode", "edit")
  if (opts.overwrite) params.set("overwrite", "1")
  if (opts.environmentId !== undefined) params.set("env", String(opts.environmentId))
  return `/api/uploads/files?${params}`
}
