import { describe, expect, it } from "vitest"

import { bulkSummary, runBulk, uniqueBy } from "@/lib/bulk"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("runBulk", () => {
  it("keeps input order and separates failures", async () => {
    const res = await runBulk([1, 2, 3, 4], async (n) => {
      await sleep(5 - n)
      if (n % 2 === 0) throw new Error(`bad ${n}`)
    })
    expect(res.done).toEqual([1, 3])
    expect(res.failed).toEqual([
      { item: 2, error: "bad 2" },
      { item: 4, error: "bad 4" },
    ])
  })

  it("never runs more than `concurrency` workers at once", async () => {
    let active = 0
    let peak = 0
    await runBulk(Array.from({ length: 10 }, (_, i) => i), async () => {
      active++
      peak = Math.max(peak, active)
      await sleep(2)
      active--
    }, { concurrency: 3 })
    expect(peak).toBe(3)
  })

  it("handles an empty list and custom error messages", async () => {
    expect(await runBulk([], async () => {})).toEqual({ done: [], failed: [] })
    const res = await runBulk(["a"], async () => {
      throw "boom"
    }, { errorMessage: () => "mapped" })
    expect(res.failed).toEqual([{ item: "a", error: "mapped" }])
  })
})

describe("bulkSummary", () => {
  const opts = { verb: "Stopped", noun: "container", label: (s: string) => s }

  it("reports success with the right plural", () => {
    expect(bulkSummary({ done: ["a"], failed: [] }, opts)).toEqual({ ok: true, message: "Stopped 1 container" })
    expect(bulkSummary({ done: ["a", "b"], failed: [] }, opts)).toEqual({ ok: true, message: "Stopped 2 containers" })
  })

  it("names the first failures and counts the rest", () => {
    const failed = ["w", "x", "y", "z"].map((item) => ({ item, error: "in use" }))
    expect(bulkSummary({ done: ["a"], failed }, opts)).toEqual({
      error: "Stopped 1 of 5 containers. Failed: w: in use; x: in use; y: in use; and 1 more",
    })
  })
})

describe("uniqueBy", () => {
  it("drops later duplicates", () => {
    expect(uniqueBy([{ id: "a", n: 1 }, { id: "b", n: 2 }, { id: "a", n: 3 }], (x) => x.id)).toEqual([
      { id: "a", n: 1 },
      { id: "b", n: 2 },
    ])
  })
})
