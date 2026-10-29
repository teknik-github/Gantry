import { Kysely, sql, SqliteDialect } from "kysely"
import { afterEach, describe, expect, it, vi } from "vitest"

import { metrics as metricsMigration } from "@/lib/server/db/migrations/005_metrics"
import type { Database } from "@/lib/server/db/schema"
import { openSqlite } from "@/lib/server/db/sqlite"
import {
  downsample,
  hostCpuPercent,
  isMetricRange,
  mapLimit,
  metricsConfig,
  retentionCutoff,
  type MetricSample,
} from "@/lib/server/metrics"
import { skipIfBusy, withTimeout } from "@/lib/server/metrics-sampler"

const MIN = 60_000
const HOUR = 60 * MIN

function series(from: number, count: number, stepMs: number, value = (i: number) => i): MetricSample[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: from + i * stepMs,
    cpu: value(i),
    memory: value(i) * 1000,
    memTotal: 8e9,
    containers: 3,
  }))
}

describe("host cpu", () => {
  it("sums container percentages and spreads them over the host's CPUs", () => {
    expect(hostCpuPercent([50, 150], 4)).toBe(50)
    expect(hostCpuPercent([], 8)).toBe(0)
    expect(hostCpuPercent([30], 0)).toBe(30) // never divide by zero
  })
})

describe("downsampling", () => {
  const to = Date.UTC(2026, 9, 29, 12)

  it("returns small series unchanged", () => {
    const s = series(to - HOUR, 60, MIN)
    expect(downsample(s, { from: to - HOUR, to, maxPoints: 300, gapMs: 3 * MIN })).toEqual(s)
  })

  it("averages into at most maxPoints buckets", () => {
    const from = to - 7 * 24 * HOUR
    const s = series(from, 7 * 24 * 60, MIN) // a week at one per minute
    const out = downsample(s, { from, to, maxPoints: 300, gapMs: 3 * MIN })
    expect(out.length).toBeLessThanOrEqual(300)
    expect(out.length).toBeGreaterThan(290)
    expect(out.every((p) => p.cpu !== null)).toBe(true)
    // Strictly increasing timestamps inside the range.
    for (let i = 1; i < out.length; i++) expect(out[i].ts).toBeGreaterThan(out[i - 1].ts)
    expect(out[0].ts).toBeGreaterThanOrEqual(from)
    expect(out.at(-1)!.ts).toBeLessThanOrEqual(to)
    // Each point is the mean of ~34 consecutive samples (values 0..n-1).
    expect(out[0].cpu).toBeLessThan(40)
    expect(out.at(-1)!.cpu).toBeGreaterThan(s.length - 40)
  })

  it("computes bucket means and keeps the largest memory total", () => {
    const width = Math.ceil(HOUR / 1) // maxPoints 2 → one-hour buckets
    const from = Math.floor(to / width) * width - 2 * HOUR
    const s: MetricSample[] = [
      { ts: from + 1 * MIN, cpu: 10, memory: 100, memTotal: 1, containers: 1 },
      { ts: from + 2 * MIN, cpu: 20, memory: 300, memTotal: 2, containers: 3 },
      { ts: from + 61 * MIN, cpu: 40, memory: 500, memTotal: 2, containers: 2 },
    ]
    const out = downsample(s, { from, to: from + HOUR, maxPoints: 2, gapMs: 999 * HOUR })
    expect(out).toEqual([
      { ts: from + 1.5 * MIN, cpu: 15, memory: 200, memTotal: 2, containers: 2 },
      { ts: from + 61 * MIN, cpu: 40, memory: 500, memTotal: 2, containers: 2 },
    ])
  })

  it("uses epoch-aligned buckets so refreshes give stable points", () => {
    const s = series(to - 24 * HOUR, 24 * 60, MIN, (i) => i % 7)
    const a = downsample(s, { from: to - 24 * HOUR, to, maxPoints: 300, gapMs: 3 * MIN })
    const b = downsample(s, { from: to - 24 * HOUR + 1234, to: to + 1234, maxPoints: 300, gapMs: 3 * MIN })
    expect(b.slice(1, -1)).toEqual(a.slice(1, -1))
  })

  it("marks pauses in sampling as gaps", () => {
    const s = [...series(to - HOUR, 10, MIN), ...series(to - 20 * MIN, 5, MIN)]
    const out = downsample(s, { from: to - HOUR, to, maxPoints: 300, gapMs: 3 * MIN })
    expect(out).toHaveLength(16)
    const gap = out[10]
    expect(gap).toMatchObject({ cpu: null, memory: null, memTotal: null, containers: null })
    expect(gap.ts).toBeGreaterThan(out[9].ts)
    expect(gap.ts).toBeLessThan(out[11].ts)
  })

  it("handles no samples", () => {
    expect(downsample([], { from: 0, to: HOUR, maxPoints: 300, gapMs: MIN })).toEqual([])
  })
})

describe("configuration and retention", () => {
  it("defaults to a 60s interval and 7 days", () => {
    expect(metricsConfig({})).toEqual({ intervalMs: 60_000, retentionDays: 7 })
  })

  it("reads the environment and ignores invalid values", () => {
    expect(metricsConfig({ METRICS_INTERVAL_SECONDS: "30", METRICS_RETENTION_DAYS: "1.5" })).toEqual({
      intervalMs: 30_000,
      retentionDays: 1.5,
    })
    expect(metricsConfig({ METRICS_INTERVAL_SECONDS: "2", METRICS_RETENTION_DAYS: "-1" })).toEqual({
      intervalMs: 60_000,
      retentionDays: 7,
    })
    expect(metricsConfig({ METRICS_INTERVAL_SECONDS: "abc", METRICS_RETENTION_DAYS: "" })).toEqual({
      intervalMs: 60_000,
      retentionDays: 7,
    })
  })

  it("computes the retention cutoff as an ISO timestamp", () => {
    const now = Date.UTC(2026, 9, 29, 12, 0, 0)
    expect(retentionCutoff(now, 7)).toBe("2026-10-22T12:00:00.000Z")
    expect(retentionCutoff(now, 0.5)).toBe("2026-10-29T00:00:00.000Z")
  })

  it("validates ranges", () => {
    expect(isMetricRange("1h")).toBe(true)
    expect(isMetricRange("7d")).toBe(true)
    expect(isMetricRange("30d")).toBe(false)
    expect(isMetricRange("toString")).toBe(false)
    expect(isMetricRange(undefined)).toBe(false)
  })
})

describe("metrics table (SQLite)", () => {
  it("stores samples, serves ranges by ts and prunes by the retention cutoff", async () => {
    const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: openSqlite(":memory:") }) })
    await metricsMigration.up(db as Kysely<unknown>)

    const now = Date.UTC(2026, 9, 29, 12)
    const ages = [10 * 24 * HOUR, 8 * 24 * HOUR, 6 * 24 * HOUR, 2 * HOUR, 30 * MIN, MIN]
    await db
      .insertInto("metrics")
      .values(
        ages.flatMap((age, i) =>
          [1, 2].map((environment_id) => ({
            environment_id,
            ts: new Date(now - age).toISOString(),
            containers: 25,
            cpu: 12.5 + i,
            mem_used: 6_442_450_944 + i, // > 2^32: must round-trip exactly
            mem_total: 33_554_432_000,
          }))
        )
      )
      .execute()

    const lastHour = await db
      .selectFrom("metrics")
      .selectAll()
      .where("environment_id", "=", 1)
      .where("ts", ">=", new Date(now - HOUR).toISOString())
      .orderBy("ts")
      .execute()
    expect(lastHour.map((r) => r.cpu)).toEqual([16.5, 17.5])
    expect(lastHour[0].mem_used).toBe(6_442_450_948)
    expect(typeof lastHour[0].mem_used).toBe("number")

    await db.deleteFrom("metrics").where("ts", "<", retentionCutoff(now, 7)).execute()
    const left = await db.selectFrom("metrics").select(["ts"]).where("environment_id", "=", 2).execute()
    expect(left).toHaveLength(4)

    // The (environment_id, ts) index exists.
    const { rows } = await sql<{ name: string }>`select name from pragma_index_info('metrics_environment_ts_idx')`.execute(db)
    expect(rows.map((r) => r.name)).toEqual(["environment_id", "ts"])
    await db.destroy()
  })
})

describe("sampler helpers", () => {
  afterEach(() => vi.useRealTimers())

  it("skips a tick while the previous one is still running", async () => {
    let release!: () => void
    let runs = 0
    const tick = skipIfBusy(async () => {
      runs++
      await new Promise<void>((r) => (release = r))
    })
    const first = tick()
    expect(await tick()).toBeUndefined()
    expect(runs).toBe(1)
    release()
    await first
    const third = tick()
    expect(runs).toBe(2)
    release()
    await third
  })

  it("frees the slot even when a tick fails", async () => {
    let fail = true
    const tick = skipIfBusy(async () => {
      if (fail) throw new Error("db down")
      return "ok"
    })
    await expect(tick()).rejects.toThrow("db down")
    fail = false
    expect(await tick()).toBe("ok")
  })

  it("times out a slow environment without waiting for it", async () => {
    vi.useFakeTimers()
    const never = new Promise<never>(() => {})
    const p = withTimeout(never, 5_000, "too slow")
    const assertion = expect(p).rejects.toThrow("too slow")
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
    expect(await withTimeout(Promise.resolve(1), 5_000, "x")).toBe(1)
  })

  it("limits concurrency", async () => {
    let active = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBe(3)
  })
})
