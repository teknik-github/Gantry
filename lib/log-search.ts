// Log viewer search and log download options. Pure functions shared by the
// browser (search, highlighting, building the download URL) and the server
// (validating the download options).

export type LogMatch = {
  /** Index of the line in the full log. */
  line: number
  start: number
  end: number
}

export type LogSearch = {
  lines: string[]
  /** Every occurrence, in order (capped at MAX_MATCHES). */
  matches: LogMatch[]
  /** Indexes of the lines with at least one match. */
  matchingLines: number[]
  /** More matches exist than were collected. */
  capped: boolean
}

export const MAX_MATCHES = 10_000

const escapeRegExp = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")

/** Case-insensitive literal matcher for `query` (null for an empty query). */
export function matcher(query: string): RegExp | null {
  return query ? new RegExp(escapeRegExp(query), "gi") : null
}

/** Splits logs into lines (dropping the empty one after a final newline). */
export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l))
}

/** Finds `query` (case-insensitive, literal) in every line. */
export function searchLog(text: string, query: string): LogSearch {
  const lines = splitLines(text)
  const re = matcher(query)
  const matches: LogMatch[] = []
  const matchingLines: number[] = []
  let capped = false
  if (re) {
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0
      let found = false
      for (let m = re.exec(lines[i]); m; m = re.exec(lines[i])) {
        found = true
        if (matches.length >= MAX_MATCHES) {
          capped = true
          break
        }
        matches.push({ line: i, start: m.index, end: m.index + m[0].length })
      }
      if (found) matchingLines.push(i)
    }
  }
  return { lines, matches, matchingLines, capped }
}

/** The match after (+1) or before (-1) `current`, wrapping around; -1 without matches. */
export function stepMatch(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1
  if (current < 0) return direction === 1 ? 0 : count - 1
  return (current + direction + count) % count
}

export type Segment = { text: string; match: boolean; start: number }

/** A line cut into plain and matching parts, for highlighting. */
export function lineSegments(line: string, query: string): Segment[] {
  const re = matcher(query)
  if (!re) return [{ text: line, match: false, start: 0 }]
  const out: Segment[] = []
  let last = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), match: false, start: last })
    out.push({ text: m[0], match: true, start: m.index })
    last = m.index + m[0].length
  }
  if (last < line.length || !out.length) out.push({ text: line.slice(last), match: false, start: last })
  return out
}

// ---- Download --------------------------------------------------------------

export type LogDownloadOptions = {
  timestamps: boolean
  /** Unix seconds. */
  since?: number
  until?: number
  /** Number of lines from the end, or "all". */
  tail: string
}

const MAX_TAIL = 10_000_000

/** Validates ?timestamps=1&since=&until=&tail= for the download route. */
export function parseLogDownloadOptions(params: URLSearchParams): LogDownloadOptions | { error: string } {
  const time = (name: string) => {
    const raw = params.get(name)
    if (raw === null || raw === "") return undefined
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 && n < 1e11 ? n : NaN
  }
  const since = time("since")
  const until = time("until")
  if (Number.isNaN(since) || Number.isNaN(until)) return { error: "since and until must be Unix timestamps (seconds)" }
  if (since !== undefined && until !== undefined && until <= since) return { error: "until must be after since" }
  const rawTail = params.get("tail") ?? "all"
  let tail = "all"
  if (rawTail !== "all" && rawTail !== "") {
    const n = Number(rawTail)
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_TAIL) return { error: `tail must be "all" or a number of lines (1-${MAX_TAIL})` }
    tail = String(n)
  }
  return { timestamps: params.get("timestamps") === "1", since, until, tail }
}

/** URL of the log download for a container. */
export function logDownloadUrl(id: string, options: LogDownloadOptions): string {
  const q = new URLSearchParams()
  if (options.timestamps) q.set("timestamps", "1")
  if (options.since !== undefined) q.set("since", String(options.since))
  if (options.until !== undefined) q.set("until", String(options.until))
  q.set("tail", options.tail)
  return `/api/containers/${id}/logs/download?${q}`
}

/** Unix seconds for a <input type="datetime-local"> value (local time); undefined when empty or invalid. */
export function localDateTimeToUnix(value: string): number | undefined {
  if (!value) return undefined
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}
