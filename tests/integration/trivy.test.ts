import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseTrivyReport } from "@/lib/image-scan"
import type { DockerTarget } from "@/lib/server/docker/client"
import { INPUT_DIR, runTrivy, sweepScanners } from "@/lib/server/trivy"

import { docker, dockerAvailable } from "../e2e/docker"
import { generateTlsFixtures, startTlsDockerProxy, type TlsDockerProxy, type TlsFixtures } from "../helpers/tls-docker-proxy"

// A real Trivy scan of alpine:3.10 (known CVEs) through a remote-style
// TCP+TLS endpoint, so nothing relies on mounting the Docker socket. Opt-in
// (GANTRY_TEST_TRIVY=1): it pulls the scanner and the image if missing and
// downloads Trivy's database into the gantry-test-s-trivy-cache volume,
// removed afterwards unless GANTRY_TEST_KEEP_TRIVY_CACHE=1. The scanner
// image is left in place (it is what Gantry itself uses).

const enabled = process.env.GANTRY_TEST_TRIVY === "1" && (await dockerAvailable())
const IMAGE = "alpine:3.10"
const VOLUME = "gantry-test-s-trivy-cache"

describe.skipIf(!enabled)("Trivy scans over TLS", () => {
  let fx: TlsFixtures
  let proxy: TlsDockerProxy
  let pulled = false
  let imageId = ""

  beforeAll(async () => {
    process.env.TRIVY_CACHE_VOLUME = VOLUME
    fx = generateTlsFixtures()
    proxy = await startTlsDockerProxy({ ca: fx.ca, cert: fx.server.cert, key: fx.server.key })
    try {
      imageId = (await docker<{ Id: string }>("GET", `/images/${encodeURIComponent(IMAGE)}/json`)).Id
    } catch {
      await docker("POST", "/images/create?fromImage=alpine&tag=3.10")
      pulled = true
      imageId = (await docker<{ Id: string }>("GET", `/images/${encodeURIComponent(IMAGE)}/json`)).Id
    }
  }, 600_000)

  afterAll(async () => {
    if (pulled) await docker("DELETE", `/images/${encodeURIComponent(IMAGE)}`).catch(() => {})
    if (!process.env.GANTRY_TEST_KEEP_TRIVY_CACHE) await docker("DELETE", `/volumes/${VOLUME}`).catch(() => {})
    await proxy?.close()
    fx?.cleanup()
  }, 120_000)

  it("finds alpine 3.10's vulnerabilities and leaves no scanner behind", async () => {
    const target: DockerTarget = { type: "tcp", url: proxy.address, tls: { ca: fx.ca, ...fx.client } }
    const phases: string[] = []
    const started = Date.now()
    const run = await runTrivy(target, imageId, { phase: (p) => phases.push(p) })
    const parsed = parseTrivyReport(run.report, { inputPath: INPUT_DIR })
    console.log(`scan took ${Date.now() - started} ms`, run.timings, `${run.imageBytes} bytes`)

    expect(run.trivyVersion).toMatch(/^\d+\.\d+/)
    expect(run.dbVersion).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(parsed.os).toBe("alpine 3.10.9")
    expect(parsed.counts.CRITICAL).toBeGreaterThan(0)
    expect(parsed.findings.some((f) => f.id === "CVE-2021-36159" && f.pkg === "apk-tools" && f.fixed)).toBe(true)
    expect(phases).toEqual(expect.arrayContaining(["Exporting image", "Scanning"]))

    // Removal finishes in the background on a busy daemon.
    const filters = encodeURIComponent(JSON.stringify({ label: ["gantry.scanner=true"], status: ["created", "running", "exited"] }))
    expect(await docker<unknown[]>("GET", `/containers/json?all=1&filters=${filters}`)).toEqual([])
    expect(await sweepScanners(target)).toBe(0)
  }, 900_000)
})
