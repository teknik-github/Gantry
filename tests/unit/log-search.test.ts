import { describe, expect, it } from "vitest"

import {
  lineSegments,
  localDateTimeToUnix,
  logDownloadUrl,
  matcher,
  MAX_MATCHES,
  parseLogDownloadOptions,
  searchLog,
  splitLines,
  stepMatch,
} from "@/lib/log-search"

const LOG = [
  "2026-10-31T10:00:00Z GET /health 200",
  "2026-10-31T10:00:01Z ERROR database timeout",
  "2026-10-31T10:00:02Z retrying (error count: 2)",
  "2026-10-31T10:00:03Z ok",
  "",
].join("\n")

describe("log search", () => {
  it("splits lines without a phantom last line and strips CR", () => {
    expect(splitLines("")).toEqual([])
    expect(splitLines("a\nb\n")).toEqual(["a", "b"])
    expect(splitLines("a\r\nb")).toEqual(["a", "b"])
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"])
  })

  it("finds every occurrence, case-insensitively", () => {
    const s = searchLog(LOG, "error")
    expect(s.lines).toHaveLength(4)
    expect(s.matches).toEqual([
      { line: 1, start: 21, end: 26 },
      { line: 2, start: 31, end: 36 },
    ])
    expect(s.matchingLines).toEqual([1, 2])
    expect(searchLog(LOG, "ERROR").matches).toHaveLength(2)
  })

  it("counts several matches on one line", () => {
    const s = searchLog("aaa\nbab\n", "a")
    expect(s.matches).toHaveLength(4)
    expect(s.matchingLines).toEqual([0, 1])
  })

  it("treats the query literally, not as a regular expression", () => {
    expect(searchLog(LOG, "(error").matches).toHaveLength(1)
    expect(searchLog(LOG, ".*").matches).toHaveLength(0)
    expect(searchLog("a+b a+b\n", "a+b").matches).toHaveLength(2)
    expect(searchLog("price $5 [x]\n", "$5 [x]").matches).toHaveLength(1)
  })

  it("matches nothing for an empty query", () => {
    const s = searchLog(LOG, "")
    expect(s.matches).toEqual([])
    expect(s.matchingLines).toEqual([])
    expect(matcher("")).toBeNull()
  })

  it("caps the number of matches", () => {
    const s = searchLog("x".repeat(MAX_MATCHES + 5), "x")
    expect(s.matches).toHaveLength(MAX_MATCHES)
    expect(s.capped).toBe(true)
  })

  it("steps through matches with wrap-around", () => {
    expect(stepMatch(-1, 0, 1)).toBe(-1)
    expect(stepMatch(-1, 3, 1)).toBe(0)
    expect(stepMatch(-1, 3, -1)).toBe(2)
    expect(stepMatch(0, 3, 1)).toBe(1)
    expect(stepMatch(2, 3, 1)).toBe(0)
    expect(stepMatch(0, 3, -1)).toBe(2)
  })

  it("cuts a line into highlighted segments keeping the original case", () => {
    expect(lineSegments("Error: an error", "ERROR")).toEqual([
      { text: "Error", match: true, start: 0 },
      { text: ": an ", match: false, start: 5 },
      { text: "error", match: true, start: 10 },
    ])
    expect(lineSegments("nothing here", "x")).toEqual([{ text: "nothing here", match: false, start: 0 }])
    expect(lineSegments("", "x")).toEqual([{ text: "", match: false, start: 0 }])
    expect(lineSegments("abc", "")).toEqual([{ text: "abc", match: false, start: 0 }])
  })
})

describe("log download options", () => {
  const parse = (q: string) => parseLogDownloadOptions(new URLSearchParams(q))

  it("defaults to the whole log without timestamps", () => {
    expect(parse("")).toEqual({ timestamps: false, since: undefined, until: undefined, tail: "all" })
  })

  it("accepts timestamps, a time range and a tail", () => {
    expect(parse("timestamps=1&since=1700000000&until=1700003600.5&tail=200")).toEqual({
      timestamps: true,
      since: 1700000000,
      until: 1700003600.5,
      tail: "200",
    })
    expect(parse("tail=all")).toMatchObject({ tail: "all" })
  })

  it("rejects bad values", () => {
    expect(parse("since=yesterday")).toHaveProperty("error")
    expect(parse("since=-5")).toHaveProperty("error")
    expect(parse("since=100&until=50")).toHaveProperty("error")
    expect(parse("tail=0")).toHaveProperty("error")
    expect(parse("tail=1.5")).toHaveProperty("error")
    expect(parse("tail=99999999999")).toHaveProperty("error")
  })

  it("builds the download URL the route parses back", () => {
    const options = { timestamps: true, since: 1700000000, until: undefined, tail: "50" }
    const url = logDownloadUrl("abc123abc123", options)
    expect(url.startsWith("/api/containers/abc123abc123/logs/download?")).toBe(true)
    expect(parseLogDownloadOptions(new URL(url, "http://x").searchParams)).toEqual(options)
  })

  it("converts datetime-local values", () => {
    expect(localDateTimeToUnix("")).toBeUndefined()
    expect(localDateTimeToUnix("not a date")).toBeUndefined()
    expect(localDateTimeToUnix("2026-10-31T10:00")).toBe(Math.floor(new Date("2026-10-31T10:00").getTime() / 1000))
  })
})
