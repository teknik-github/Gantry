// Line diff (Myers' O(ND) algorithm) and unified-style hunks, for the
// "Edit YAML" review step. Pure, so the browser and unit tests can use it.

export type DiffLine = {
  type: "context" | "add" | "remove"
  text: string
  /** 1-based line number in the old text (context and removed lines). */
  oldNo?: number
  /** 1-based line number in the new text (context and added lines). */
  newNo?: number
}

export type DiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export type DiffResult = {
  hunks: DiffHunk[]
  added: number
  removed: number
  /** The texts differed too much for a minimal diff: everything old is removed, everything new added. */
  approximate: boolean
}

type Op = { type: "=" | "-" | "+"; text: string }

/** Edit distance beyond which we give up on a minimal diff (bounds time and memory to O(MAX_D²)). */
const MAX_D = 2000

/**
 * Myers' shortest edit script between `a` and `b`, or null when it needs
 * more than `maxD` edits. Keeps one slice of V per round (O(D²) memory).
 */
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  const limit = Math.min(max, maxD)

  for (let d = 0; d <= limit; d++) {
    // V as it was before this round, for k in [-d-1, d+1].
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(a, b, trace)
    }
  }
  return null
}

function backtrack(a: string[], b: string[], trace: Int32Array[]): Op[] {
  const ops: Op[] = []
  let x = a.length
  let y = b.length
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d]
    const at = (k: number) => snap[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ type: "=", text: a[x - 1] })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: "+", text: b[y - 1] })
      else ops.push({ type: "-", text: a[x - 1] })
    }
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** The edit script between two texts, line by line. */
export function diffOps(oldText: string, newText: string, maxD = MAX_D): { ops: Op[]; approximate: boolean } {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  // Common prefix and suffix need no search.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const head: Op[] = a.slice(0, start).map((text) => ({ type: "=", text }))
  const tail: Op[] = a.slice(endA).map((text) => ({ type: "=", text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  let mid = myers(midA, midB, maxD)
  const approximate = mid === null
  if (!mid) {
    mid = [...midA.map((text) => ({ type: "-" as const, text })), ...midB.map((text) => ({ type: "+" as const, text }))]
  }
  return { ops: [...head, ...mid, ...tail], approximate }
}

/** Unified diff hunks with `context` unchanged lines around each change. */
export function diffText(oldText: string, newText: string, context = 3, maxD = MAX_D): DiffResult {
  const { ops, approximate } = diffOps(oldText, newText, maxD)
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.type === "=") lines.push({ type: "context", text: op.text, oldNo: ++oldNo, newNo: ++newNo })
    else if (op.type === "-") {
      removed++
      lines.push({ type: "remove", text: op.text, oldNo: ++oldNo })
    } else {
      added++
      lines.push({ type: "add", text: op.text, newNo: ++newNo })
    }
  }

  const hunks: DiffHunk[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type === "context") {
      i++
      continue
    }
    // A change: take `context` lines before it and extend while changes are close.
    const from = Math.max(0, i - context)
    let to = i
    let lastChange = i
    while (to < lines.length) {
      if (lines[to].type !== "context") lastChange = to
      else if (to - lastChange > 2 * context) break
      to++
    }
    const end = Math.min(lines.length, lastChange + context + 1)
    const slice = lines.slice(from, end)
    const firstOld = slice.find((l) => l.oldNo !== undefined)?.oldNo
    const firstNew = slice.find((l) => l.newNo !== undefined)?.newNo
    const oldLines = slice.filter((l) => l.type !== "add").length
    const newLines = slice.filter((l) => l.type !== "remove").length
    hunks.push({
      // Like diff -u: a hunk without old (new) lines starts after the preceding line.
      oldStart: firstOld ?? (slice.length ? precedingNo(lines, from, "oldNo") : 0),
      oldLines,
      newStart: firstNew ?? (slice.length ? precedingNo(lines, from, "newNo") : 0),
      newLines,
      lines: slice,
    })
    i = end
  }
  return { hunks, added, removed, approximate }
}

function precedingNo(lines: DiffLine[], index: number, key: "oldNo" | "newNo") {
  for (let j = index - 1; j >= 0; j--) {
    const n = lines[j][key]
    if (n !== undefined) return n
  }
  return 0
}

/** The hunks as `diff -u` text (without file headers). */
export function formatUnified(hunks: DiffHunk[]): string {
  const out: string[] = []
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const l of h.lines) out.push(`${l.type === "add" ? "+" : l.type === "remove" ? "-" : " "}${l.text}`)
  }
  return out.join("\n")
}
