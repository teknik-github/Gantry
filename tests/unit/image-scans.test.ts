import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import type { Kysely } from "kysely"

import type { Database } from "@/lib/server/db/schema"
import { openTestDb } from "../helpers/test-db"

// The scan queue and its storage against a real (throwaway) database, with
// Trivy and Docker replaced: what is stored, what a failed scan keeps, and
// which scans raise "vulnerability" alerts.

const h = vi.hoisted(() => ({
  db: null as unknown as Kysely<Database>,
  reports: [] as (unknown | Error)[],
  alerts: [] as { kind: string; subject: string; message: string }[],
  gate: null as Promise<void> | null,
}))

vi.mock("@/lib/server/db", () => ({ getDb: async () => h.db }))
vi.mock("@/lib/server/notifications", () => ({
  notify: async (alert: { kind: string; subject: string; message: string }) => void h.alerts.push(alert),
}))
vi.mock("@/lib/server/docker/api", () => ({
  docker: () => ({ inspectImage: async () => ({ Id: "x", RepoTags: ["alpine:3.10"], RepoDigests: ["alpine@sha256:abc"] }) }),
}))
vi.mock("@/lib/server/trivy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/trivy")>()
  return {
    ...actual,
    runTrivy: async (_target: unknown, _id: string, opts: { phase?: (s: string) => void }) => {
      opts.phase?.("Scanning")
      if (h.gate) await h.gate
      const next = h.reports.shift()
      if (next instanceof Error) throw next
      return { report: next, trivyVersion: "0.76.1", dbVersion: "2026-10-31T01:14:32Z", imageBytes: 1, timings: { pull: 0, copy: 0, scan: 0 } }
    },
  }
})

const { enqueueScans, pendingScans, saveImageScanSettings, scanDetails, scanSummaries } = await import("@/lib/server/image-scans")
const { ScanError } = await import("@/lib/server/trivy")

const IMAGE = `sha256:${"a".repeat(64)}`
const OTHER = `sha256:${"b".repeat(64)}`
const v = (id: string, pkg: string, Severity: string) => ({ VulnerabilityID: id, PkgName: pkg, InstalledVersion: "1", FixedVersion: "2", Severity })
const reportOf = (...vulns: ReturnType<typeof v>[]) => ({ SchemaVersion: 2, Results: [{ Target: "/scan/image (alpine 3.10.9)", Vulnerabilities: vulns }] })

let t: Awaited<ReturnType<typeof openTestDb>>
let envId = 0

beforeAll(async () => {
  t = await openTestDb()
  h.db = t.db
  const r = await t.db
    .insertInto("environments")
    .values({ name: "local", type: "socket", url: "/var/run/docker.sock", created_at: new Date().toISOString(), tls_ca: null, tls_cert: null, tls_key: null, kube_credentials: null, kube_namespace: null })
    .executeTakeFirstOrThrow()
  envId = Number(r.insertId)
})

afterAll(async () => {
  await t?.cleanup()
})

beforeEach(() => {
  h.alerts.length = 0
  h.reports.length = 0
})

async function drained() {
  await vi.waitFor(() => expect(pendingScans(envId).size).toBe(0), { timeout: 5000 })
}

describe("image scans", () => {
  it("queues one scan at a time per environment and skips duplicates", async () => {
    let open = () => {}
    h.gate = new Promise<void>((resolve) => (open = resolve))
    h.reports.push(reportOf(v("CVE-1", "apk-tools", "CRITICAL"), v("CVE-2", "musl", "LOW")), reportOf())
    const first = enqueueScans(envId, [
      { imageId: IMAGE, reference: "alpine:3.10" },
      { imageId: OTHER, reference: "other:1" },
      { imageId: IMAGE, reference: "alpine:3.10" },
    ])
    expect(first).toMatchObject({ queued: 2, skipped: 1 })
    await vi.waitFor(() => expect(pendingScans(envId).get(IMAGE)).toEqual({ pending: "running", phase: "Scanning" }))
    expect(pendingScans(envId).get(OTHER)).toEqual({ pending: "queued", phase: null })
    expect(enqueueScans(envId, [{ imageId: OTHER, reference: "other:1" }]).queued).toBe(0)
    expect((await scanSummaries(envId)).find((s) => s.imageId === IMAGE)).toMatchObject({ pending: "running", phase: "Scanning", scannedAt: null })

    h.gate = null
    open()
    await drained()

    const summaries = await scanSummaries(envId)
    expect(summaries.find((s) => s.imageId === IMAGE)).toMatchObject({
      reference: "alpine:3.10",
      counts: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 1, UNKNOWN: 0 },
      error: null,
      pending: null,
    })
    expect(summaries.find((s) => s.imageId === OTHER)?.counts.CRITICAL).toBe(0)
    const details = await scanDetails(envId, IMAGE)
    expect(details).toMatchObject({ trivyVersion: "0.76.1", dbVersion: "2026-10-31T01:14:32Z", repoDigest: "alpine@sha256:abc", os: null })
    expect(details?.findings.map((f) => [f.id, f.target])).toEqual([
      ["CVE-1", "alpine 3.10.9"],
      ["CVE-2", "alpine 3.10.9"],
    ])
    // First scan: the critical finding (default threshold) is announced, once.
    expect(h.alerts).toEqual([
      { kind: "vulnerability", environment: "local", subject: "alpine:3.10: 1 new vulnerability (1 critical)", message: "CVE-1 [critical] apk-tools 1 → fixed in 2" },
    ])
  })

  it("alerts only on new findings at or above the threshold on later scans", async () => {
    h.reports.push(reportOf(v("CVE-1", "apk-tools", "CRITICAL"), v("CVE-2", "musl", "LOW")))
    enqueueScans(envId, [{ imageId: IMAGE, reference: "alpine:3.10" }])
    await drained()
    expect(h.alerts).toEqual([])

    await saveImageScanSettings({ enabled: false, time: "04:00", minSeverity: "HIGH" })
    h.reports.push(reportOf(v("CVE-1", "apk-tools", "CRITICAL"), v("CVE-3", "zlib", "HIGH"), v("CVE-4", "busybox", "MEDIUM")))
    enqueueScans(envId, [{ imageId: IMAGE, reference: "alpine:3.10" }])
    await drained()
    expect(h.alerts.map((a) => a.subject)).toEqual(["alpine:3.10: 1 new vulnerability (1 high)"])
    await saveImageScanSettings({ enabled: false, time: "04:00", minSeverity: "CRITICAL" })
  })

  it("keeps the last results when a scan fails, and records the error", async () => {
    h.reports.push(new ScanError("Trivy couldn't download its vulnerability database"))
    enqueueScans(envId, [{ imageId: IMAGE, reference: "alpine:3.10" }])
    await drained()
    const details = await scanDetails(envId, IMAGE)
    expect(details?.error).toBe("Trivy couldn't download its vulnerability database")
    expect(details?.scannedAt).not.toBeNull()
    expect(details?.counts.HIGH).toBe(1)
    expect(details?.findings).toHaveLength(3)

    // A failed first scan of another image stores just the error.
    const third = `sha256:${"c".repeat(64)}`
    h.reports.push(new Error("boom"))
    enqueueScans(envId, [{ imageId: third, reference: "c:1" }])
    await drained()
    expect((await scanSummaries(envId)).find((s) => s.imageId === third)).toMatchObject({
      scannedAt: null,
      error: "Unexpected error; check the server logs",
    })
    expect(h.alerts).toEqual([])
  })

  it("removes an environment's scans with the environment", async () => {
    await t.db.deleteFrom("environments").where("id", "=", envId).execute()
    expect(await t.db.selectFrom("image_scans").selectAll().execute()).toEqual([])
  })
})
