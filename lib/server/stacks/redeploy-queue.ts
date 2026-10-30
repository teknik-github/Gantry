// Coalesces redeploy requests per stack (no server imports, unit-tested).
//
// A burst of webhook deliveries (several pushes, a provider retrying, a
// webhook plus a poll) must not queue a deploy each: requests within the
// delay merge into one run, a request while a run is in progress queues
// exactly one follow-up run (so the newest commit is deployed), and further
// requests merge into that follow-up.

export type QueueOutcome = "scheduled" | "merged" | "queued"

type Entry<R> = { timer: ReturnType<typeof setTimeout> | null; running: boolean; again: boolean; reasons: R[] }

export class RedeployQueue<K, R = string> {
  private entries = new Map<K, Entry<R>>()

  constructor(
    private readonly run: (key: K, reasons: R[]) => Promise<void>,
    private readonly delayMs = 3_000
  ) {}

  request(key: K, reason: R): QueueOutcome {
    const entry = this.entries.get(key)
    if (!entry) {
      const fresh: Entry<R> = { timer: null, running: false, again: false, reasons: [reason] }
      this.entries.set(key, fresh)
      this.schedule(key, fresh)
      return "scheduled"
    }
    entry.reasons.push(reason)
    if (entry.running && !entry.again) {
      entry.again = true
      return "queued"
    }
    return "merged"
  }

  /** Whether a run for `key` is waiting or in progress. */
  pending(key: K) {
    return this.entries.has(key)
  }

  private schedule(key: K, entry: Entry<R>) {
    entry.timer = setTimeout(() => void this.fire(key, entry), this.delayMs)
    entry.timer.unref?.()
  }

  private async fire(key: K, entry: Entry<R>) {
    entry.timer = null
    entry.running = true
    const reasons = entry.reasons
    entry.reasons = []
    try {
      await this.run(key, reasons)
    } catch (err) {
      console.error("[gantry] queued redeploy failed", err)
    } finally {
      entry.running = false
      if (entry.again) {
        entry.again = false
        this.schedule(key, entry)
      } else {
        this.entries.delete(key)
      }
    }
  }
}
