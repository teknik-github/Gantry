import { describe, expect, it } from "vitest"

import { checkThresholds, ThresholdTracker, type Thresholds } from "@/lib/thresholds"

const GiB = 1024 ** 3
const t: Thresholds = { containerCpu: 90, containerMemory: 80, hostMemory: 90, minutes: 5 }
const c = (cpu: number, memory = 0.1 * GiB, memLimit = 1 * GiB) => ({ id: "c1", name: "web", cpu, memory, memLimit })

function tracker() {
  let now = 0
  const tr = new ThresholdTracker(() => now)
  return { tr, at: (min: number) => (now = min * 60_000) }
}

describe("ThresholdTracker", () => {
  it("alerts only after the value stayed above for the whole duration", () => {
    const { tr, at } = tracker()
    const host = { memory: 1 * GiB, memTotal: 16 * GiB }
    at(0)
    expect(tr.sample({ containers: [c(95)], host }, t)).toEqual([])
    at(3)
    expect(tr.sample({ containers: [c(95)], host }, t)).toEqual([])
    at(5)
    expect(tr.sample({ containers: [c(97)], host }, t)).toMatchObject([{ kind: "resource_high", subject: "web CPU at 97%" }])
    // Cooldown: no repeat within the hour.
    at(30)
    expect(tr.sample({ containers: [c(99)], host }, t)).toEqual([])
    at(66)
    expect(tr.sample({ containers: [c(99)], host }, t)).toHaveLength(1)
  })

  it("a dip below resets the timer", () => {
    const { tr, at } = tracker()
    const host = { memory: 0, memTotal: 16 * GiB }
    at(0)
    tr.sample({ containers: [c(95)], host }, t)
    at(4)
    tr.sample({ containers: [c(10)], host }, t)
    at(6)
    expect(tr.sample({ containers: [c(95)], host }, t)).toEqual([])
    at(11)
    expect(tr.sample({ containers: [c(95)], host }, t)).toHaveLength(1)
  })

  it("checks memory against the container limit and the host total; null turns a check off", () => {
    const { tr, at } = tracker()
    const host = { memory: 15 * GiB, memTotal: 16 * GiB }
    const sample = { containers: [c(1, 0.9 * GiB, 1 * GiB)], host }
    at(0)
    tr.sample(sample, t)
    at(5)
    const alerts = tr.sample(sample, t).map((a) => a.subject)
    expect(alerts).toEqual(["web memory at 90%", "Containers use 94% of the host's memory"])
    const { tr: off, at: at2 } = tracker()
    const none = { ...t, containerMemory: null, hostMemory: null }
    at2(0)
    off.sample(sample, none)
    at2(10)
    expect(off.sample(sample, none)).toEqual([])
  })
})

describe("checkThresholds", () => {
  it("treats empty fields as off and validates ranges", () => {
    expect(checkThresholds({ containerCpu: "", containerMemory: "85", hostMemory: "", minutes: "10" })).toEqual({
      thresholds: { containerCpu: null, containerMemory: 85, hostMemory: null, minutes: 10 },
      errors: {},
    })
    expect(checkThresholds({ containerMemory: "150", minutes: "0" }).errors).toEqual({ containerMemory: "1-100", minutes: "1-1440" })
  })
})
