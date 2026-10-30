import "server-only"

type Bucket = { count: number; resetAt: number }

const globalForRl = globalThis as unknown as { __gantryRl?: Map<string, Bucket> }
const buckets = (globalForRl.__gantryRl ??= new Map())

/** Fixed-window in-memory limiter. Returns seconds to wait, or 0 when allowed. */
export function checkRateLimit(key: string, limit: number): number {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) return 0
  return bucket.count >= limit ? Math.ceil((bucket.resetAt - now) / 1000) : 0
}

/** Counts a failure; returns the number of failures in the current window. */
export function recordFailure(key: string, windowMs: number): number {
  const now = Date.now()
  let bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 1, resetAt: now + windowMs }
    buckets.set(key, bucket)
  } else {
    bucket.count++
  }
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k)
  }
  return bucket.count
}

export function clearFailures(key: string) {
  buckets.delete(key)
}
