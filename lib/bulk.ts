// Bulk operations on several Docker objects: bounded concurrency, input order
// kept, and a summary that names what failed. Pure, so Server Actions and unit
// tests share it.

import type { ActionState } from "@/lib/validation"

/** Most objects one bulk request may touch. */
export const BULK_LIMIT = 200

export type BulkResult<T> = { done: T[]; failed: { item: T; error: string }[] }

export async function runBulk<T>(
  items: readonly T[],
  worker: (item: T) => Promise<void>,
  { concurrency = 4, errorMessage = (err: unknown) => (err as Error)?.message || "Failed" }: {
    concurrency?: number
    errorMessage?: (err: unknown) => string
  } = {}
): Promise<BulkResult<T>> {
  const errors: (string | null)[] = []
  let next = 0
  async function lane() {
    while (next < items.length) {
      const i = next++
      try {
        await worker(items[i])
        errors[i] = null
      } catch (err) {
        errors[i] = errorMessage(err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, lane))

  const result: BulkResult<T> = { done: [], failed: [] }
  items.forEach((item, i) => {
    const error = errors[i]
    if (error === null) result.done.push(item)
    else result.failed.push({ item, error: error ?? "Failed" })
  })
  return result
}

const MAX_LISTED = 3

/**
 * How a summary is worded in another language than English: the sentences
 * (with {verb} {count} {done} {total} {noun} {failures} placeholders) and
 * the noun's form for a count.
 */
export type BulkWording = {
  success: string
  partial: string
  more: string
  noun: (count: number) => string
}

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))

/** "Stopped 3 containers", or an error naming the first few failures. */
export function bulkSummary<T>(
  { done, failed }: BulkResult<T>,
  { verb, noun, label, wording }: { verb: string; noun: string; label: (item: T) => string; wording?: BulkWording }
): ActionState {
  const total = done.length + failed.length
  const nouns = wording?.noun ?? ((n: number) => `${noun}${n === 1 ? "" : "s"}`)
  if (!failed.length) {
    if (wording) return { ok: true, message: fill(wording.success, { verb, count: total, noun: nouns(total) }) }
    return { ok: true, message: `${verb} ${total} ${nouns(total)}` }
  }

  const listed = failed.slice(0, MAX_LISTED).map((f) => `${label(f.item)}: ${f.error}`)
  const more = failed.length - MAX_LISTED
  if (more > 0) listed.push(wording ? fill(wording.more, { count: more }) : `and ${more} more`)
  if (wording) {
    return {
      error: fill(wording.partial, { verb, done: done.length, total, noun: nouns(total), failures: listed.join("; ") }),
    }
  }
  return { error: `${verb} ${done.length} of ${total} ${nouns(total)}. Failed: ${listed.join("; ")}` }
}

/** Distinct values, first occurrence wins (by key). */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const k = key(item)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
