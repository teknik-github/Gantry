import "server-only"

import { typeFromRawMode, type FileEntry } from "@/lib/files/entries"

/**
 * Folder listing through `stat` inside a running container: fast (one exec,
 * no file content read) and works with busybox and GNU coreutils. Needs
 * /bin/sh and stat in the image; otherwise the caller falls back to the
 * archive listing.
 */

const FS = "\x1f" // field separator (unit separator)
const RS = "\x1e" // record terminator (record separator), stat adds "\n" after it

/** stat -c format: raw mode (hex), size, uid, gid, user, group, mtime, name, name with link target. */
export const STAT_FORMAT = ["%f", "%s", "%u", "%g", "%U", "%G", "%Y", "%n", "%N"].join(FS) + RS

/** Exit code of LIST_SCRIPT when the folder can't be entered. */
export const NOT_A_DIRECTORY = 3

/**
 * sh -c script; $1 is the folder, $2 the format. find batches the names so
 * huge folders don't hit the argument limit; without find, shell globs
 * (".[!.]*" and "..?*" catch dot files but not . and ..). Patterns that match
 * nothing stay literal and stat complains on stderr, which is ignored.
 */
export const LIST_SCRIPT = [
  "command -v stat >/dev/null 2>&1 || exit 127",
  'cd -- "$1" 2>/dev/null || exit 3',
  "if command -v find >/dev/null 2>&1; then",
  '  exec find . -mindepth 1 -maxdepth 1 -exec stat -c "$2" -- {} +',
  "fi",
  'exec stat -c "$2" -- * .[!.]* ..?*',
].join("\n")

export function listCommand(dir: string): string[] {
  return ["sh", "-c", LIST_SCRIPT, "gantry-ls", dir, STAT_FORMAT]
}

/** QUOTING_STYLE=literal makes GNU stat print %N as `name -> target`; busybox quotes as 'name' -> 'target'. */
export const LIST_ENV = ["LC_ALL=C", "QUOTING_STYLE=literal"]

function linkTarget(name: string, quoted: string): string | undefined {
  const busybox = `'${name}' -> '`
  if (quoted.startsWith(busybox) && quoted.endsWith("'")) return quoted.slice(busybox.length, -1)
  const literal = `${name} -> `
  if (quoted.startsWith(literal)) return quoted.slice(literal.length)
  return undefined
}

/** Parses LIST_SCRIPT output into entries (unparseable records are skipped). */
export function parseStatOutput(output: string): FileEntry[] {
  const entries: FileEntry[] = []
  for (const raw of output.split(`${RS}\n`)) {
    const record = raw.replace(/^\n/, "")
    if (!record) continue
    const f = record.split(FS)
    if (f.length !== 9) continue
    const [hexMode, size, uid, gid, user, group, mtime, rawName, quoted] = f
    const mode = parseInt(hexMode, 16)
    if (!Number.isFinite(mode)) continue
    const name = rawName.replace(/^\.\//, "")
    if (!name || name === "." || name === ".." || name.includes("/")) continue
    const { type, kind } = typeFromRawMode(mode)
    const quotedName = quoted.startsWith("'./") || quoted.startsWith("./") ? quoted.replace(/^('?)\.\//, "$1") : quoted
    entries.push({
      name,
      type,
      kind,
      size: Number(size) || 0,
      mode: mode & 0o7777,
      uid: Number(uid) || 0,
      gid: Number(gid) || 0,
      user: user && user !== "UNKNOWN" ? user : undefined,
      group: group && group !== "UNKNOWN" ? group : undefined,
      mtime: Number(mtime) || 0,
      linkTarget: type === "symlink" ? linkTarget(name, quotedName) : undefined,
    })
  }
  return entries
}
