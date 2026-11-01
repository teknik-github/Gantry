import "server-only"

import { containerName } from "@/lib/format"
import { cpuPercent, memoryUsage, type DockerApi } from "@/lib/server/docker/api"

// Host-level resource usage of an environment: the math shared by the live
// /api/stats endpoint and the background sampler (lib/server/metrics-sampler.ts),
// plus the helpers for storing and serving the history (/api/metrics).

export type ContainerUsage = {
  id: string
  name: string
  cpu: number
  memory: number
  /** The container's memory limit (the host's memory when it has none). */
  memLimit: number
}

export type HostUsage = {
  /** Sum of container CPU, normalised to the whole host (100% = all CPUs busy). */
  cpu: number
  /** Memory used by the sampled containers, excluding page cache. */
  memory: number
  memTotal: number
  ncpu: number
  /** All running containers, even when only some were sampled. */
  running: number
  containers: ContainerUsage[]
}

/** Container CPU percentages (100% = one core) summed and spread over the host's CPUs. */
export function hostCpuPercent(containerCpu: number[], ncpu: number) {
  return containerCpu.reduce((a, c) => a + c, 0) / Math.max(1, ncpu)
}

/** Runs `fn` over `items` with at most `limit` calls in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

/**
 * One reading of an environment's usage. Each container's stats call takes
 * Docker about a second (it waits for a second CPU sample), so calls run in
 * parallel up to `concurrency`.
 */
export async function sampleHost(
  api: DockerApi,
  opts: { maxContainers?: number; concurrency?: number } = {}
): Promise<HostUsage> {
  const [info, running] = await Promise.all([api.info(), api.listContainers(false)])
  const sampled = running.slice(0, opts.maxContainers ?? running.length)

  const samples = await mapLimit(sampled, opts.concurrency ?? 8, async (c): Promise<ContainerUsage | null> => {
    try {
      const s = await api.containerStats(c.Id)
      return {
        id: c.Id,
        name: containerName(c),
        cpu: cpuPercent(s),
        memory: memoryUsage(s),
        memLimit: s.memory_stats.limit ?? 0,
      }
    } catch {
      return null // container stopped mid-request
    }
  })
  const containers = samples.filter((s) => s !== null)

  return {
    cpu: hostCpuPercent(
      containers.map((c) => c.cpu),
      info.NCPU
    ),
    memory: containers.reduce((a, c) => a + c.memory, 0),
    memTotal: info.MemTotal,
    ncpu: info.NCPU,
    running: running.length,
    containers,
  }
}

// ---- Configuration --------------------------------------------------------

function positiveNumber(value: string | undefined, fallback: number, min: number) {
  const n = Number(value)
  return value !== undefined && value !== "" && Number.isFinite(n) && n >= min ? n : fallback
}

export function metricsConfig(env: Record<string, string | undefined> = process.env) {
  return {
    /** METRICS_INTERVAL_SECONDS (default 60, minimum 10). */
    intervalMs: positiveNumber(env.METRICS_INTERVAL_SECONDS, 60, 10) * 1000,
    /** METRICS_RETENTION_DAYS (default 7, fractions allowed). */
    retentionDays: positiveNumber(env.METRICS_RETENTION_DAYS, 7, 0.01),
  }
}

/** Rows older than this ISO timestamp are pruned. */
export function retentionCutoff(now: number, retentionDays: number) {
  return new Date(now - retentionDays * 24 * 60 * 60_000).toISOString()
}

// ---- History ranges and downsampling -------------------------------------

export const METRIC_RANGES = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
} as const
export type MetricRange = keyof typeof METRIC_RANGES

export function isMetricRange(value: unknown): value is MetricRange {
  return typeof value === "string" && Object.hasOwn(METRIC_RANGES, value)
}

export type MetricSample = { ts: number; cpu: number; memory: number; memTotal: number; containers: number }

/** A chart point; all values null marks a gap (no samples, e.g. Gantry was down). */
export type MetricPoint = {
  ts: number
  cpu: number | null
  memory: number | null
  memTotal: number | null
  containers: number | null
}

/**
 * Reduces samples (sorted by ts) to at most `maxPoints` by averaging them in
 * fixed time buckets aligned to the epoch, so the same history gives the same
 * points on every refresh. Pauses longer than `gapMs` become null points so
 * the chart shows a break instead of a straight line across them.
 */
export function downsample(
  samples: MetricSample[],
  opts: { from: number; to: number; maxPoints: number; gapMs: number }
): MetricPoint[] {
  let points: MetricPoint[] = samples
  let gapMs = opts.gapMs

  if (samples.length > opts.maxPoints) {
    const width = Math.ceil((opts.to - opts.from) / Math.max(1, opts.maxPoints - 1))
    gapMs = Math.max(gapMs, 2 * width)
    const buckets = new Map<number, MetricSample[]>()
    for (const s of samples) {
      const key = Math.floor(s.ts / width)
      const bucket = buckets.get(key)
      if (bucket) bucket.push(s)
      else buckets.set(key, [s])
    }
    const mean = (list: MetricSample[], pick: (s: MetricSample) => number) =>
      list.reduce((a, s) => a + pick(s), 0) / list.length
    points = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, list]) => ({
        ts: Math.round(mean(list, (s) => s.ts)),
        cpu: mean(list, (s) => s.cpu),
        memory: mean(list, (s) => s.memory),
        memTotal: Math.max(...list.map((s) => s.memTotal)),
        containers: mean(list, (s) => s.containers),
      }))
      .slice(-opts.maxPoints)
  }

  const out: MetricPoint[] = []
  for (const p of points) {
    const prev = out.at(-1)
    if (prev && p.ts - prev.ts > gapMs) {
      out.push({ ts: Math.round((prev.ts + p.ts) / 2), cpu: null, memory: null, memTotal: null, containers: null })
    }
    out.push(p)
  }
  return out
}
