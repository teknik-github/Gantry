import { describe, expect, it } from "vitest"

import {
  describeCounts,
  findingKey,
  newFindings,
  parseTrivyReport,
  ReportError,
  vulnerabilityAlert,
  type Finding,
} from "@/lib/image-scan"
import { directoryTar, firstTarFile, trivyFailure } from "@/lib/server/trivy"
import { singleFileTar } from "@/lib/server/tar"

const vuln = (id: string, pkg: string, severity: string, extra: Record<string, unknown> = {}) => ({
  VulnerabilityID: id,
  PkgName: pkg,
  InstalledVersion: "1.0",
  FixedVersion: "1.1",
  Severity: severity,
  Title: `${id} in ${pkg}`,
  PrimaryURL: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
  ...extra,
})

/** Shaped like `trivy image --format json` output (trimmed). */
const report = {
  SchemaVersion: 2,
  Trivy: { Version: "0.76.1" },
  ArtifactName: "/scan/image",
  Metadata: { OS: { Family: "alpine", Name: "3.10.9", EOSL: true } },
  Results: [
    {
      Target: "/scan/image (alpine 3.10.9)",
      Class: "os-pkgs",
      Type: "alpine",
      Vulnerabilities: [
        vuln("CVE-2021-36159", "apk-tools", "CRITICAL", { InstalledVersion: "2.10.6-r0", FixedVersion: "2.10.7-r0" }),
        vuln("CVE-2021-3711", "libcrypto1.1", "CRITICAL"),
        vuln("CVE-2021-3711", "libssl1.1", "CRITICAL"),
        vuln("CVE-2021-23840", "libcrypto1.1", "HIGH", { FixedVersion: "" }),
        vuln("CVE-2021-3449", "libssl1.1", "medium"),
        vuln("CVE-2020-1971", "libssl1.1", "LOW", { PrimaryURL: "javascript:alert(1)" }),
        vuln("CVE-2099-0001", "musl", "WHATEVER"),
      ],
    },
    {
      Target: "usr/local/bin/gosu",
      Class: "lang-pkgs",
      Type: "gobinary",
      Vulnerabilities: [
        vuln("CVE-2023-0001", "stdlib", "HIGH", { InstalledVersion: "v1.18.2" }),
        // The same vulnerability of the same package version twice: listed once.
        vuln("CVE-2023-0001", "stdlib", "HIGH", { InstalledVersion: "v1.18.2" }),
      ],
    },
    { Target: "Java", Class: "lang-pkgs", Type: "jar" },
  ],
}

describe("parseTrivyReport", () => {
  it("turns a report into findings, counts and the OS", () => {
    const parsed = parseTrivyReport(report, { inputPath: "/scan/image" })
    expect(parsed.counts).toEqual({ CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 1, UNKNOWN: 1 })
    expect(parsed.findings).toHaveLength(8)
    expect(parsed.truncated).toBe(false)
    expect(parsed.os).toBe("alpine 3.10.9")
    expect(parsed.findings[0]).toEqual({
      id: "CVE-2021-36159",
      pkg: "apk-tools",
      installed: "2.10.6-r0",
      fixed: "2.10.7-r0",
      severity: "CRITICAL",
      title: "CVE-2021-36159 in apk-tools",
      url: "https://avd.aquasec.com/nvd/cve-2021-36159",
      target: "alpine 3.10.9",
    })
    // Most severe first; unknown severities last.
    expect(parsed.findings.map((f) => f.severity)).toEqual(["CRITICAL", "CRITICAL", "CRITICAL", "HIGH", "HIGH", "MEDIUM", "LOW", "UNKNOWN"])
    expect(parsed.findings.find((f) => f.pkg === "stdlib")?.target).toBe("usr/local/bin/gosu")
    // Only http(s) links are kept.
    expect(parsed.findings.find((f) => f.id === "CVE-2020-1971")?.url).toBe("")
  })

  it("caps the stored findings, dropping the least severe, but counts them all", () => {
    const parsed = parseTrivyReport(report, { maxFindings: 3 })
    expect(parsed.findings.map((f) => f.severity)).toEqual(["CRITICAL", "CRITICAL", "CRITICAL"])
    expect(parsed.truncated).toBe(true)
    expect(parsed.counts.HIGH).toBe(2)
  })

  it("accepts a clean image and refuses things that aren't a report", () => {
    expect(parseTrivyReport({ SchemaVersion: 2, Results: [{ Target: "x", Class: "os-pkgs" }] }).counts.CRITICAL).toBe(0)
    expect(parseTrivyReport({ SchemaVersion: 2 }).findings).toEqual([])
    expect(() => parseTrivyReport(null)).toThrow(ReportError)
    expect(() => parseTrivyReport([])).toThrow(ReportError)
    expect(() => parseTrivyReport({ hello: "world" })).toThrow(ReportError)
  })

  it("clips long fields", () => {
    const long = parseTrivyReport({ Results: [{ Target: "t", Vulnerabilities: [vuln("CVE-1", "p", "LOW", { Title: "x".repeat(5000) })] }] })
    expect(long.findings[0].title).toHaveLength(300)
  })
})

const f = (id: string, pkg: string, severity: Finding["severity"]): Finding => ({
  id,
  pkg,
  installed: "1",
  fixed: "",
  severity,
  title: "",
  url: "",
  target: "",
})

describe("newFindings", () => {
  const before = [f("CVE-1", "a", "CRITICAL"), f("CVE-2", "b", "HIGH")]

  it("reports everything at or above the threshold on a first scan", () => {
    expect(newFindings(null, [...before, f("CVE-3", "c", "LOW")], "HIGH").map(findingKey)).toEqual(["CVE-1|a", "CVE-2|b"])
  })

  it("only reports findings the previous scan didn't have", () => {
    const next = [...before, f("CVE-9", "z", "CRITICAL"), f("CVE-1", "other", "CRITICAL"), f("CVE-8", "y", "MEDIUM")]
    expect(newFindings({ findings: before, truncated: false }, next, "CRITICAL").map(findingKey)).toEqual(["CVE-9|z", "CVE-1|other"])
    expect(newFindings({ findings: before, truncated: false }, next, "MEDIUM").map(findingKey)).toEqual([
      "CVE-9|z",
      "CVE-1|other",
      "CVE-8|y",
    ])
    // The same scan again: nothing new.
    expect(newFindings({ findings: next, truncated: false }, next, "LOW")).toEqual([])
  })

  it("ignores version changes of a known vulnerability and duplicates", () => {
    const moved = { ...before[0], installed: "2" }
    expect(newFindings({ findings: before, truncated: false }, [moved, f("CVE-5", "e", "HIGH"), f("CVE-5", "e", "HIGH")], "HIGH")).toEqual([
      f("CVE-5", "e", "HIGH"),
    ])
  })

  it("doesn't report findings at levels a truncated previous list may have missed", () => {
    const previous = { findings: [f("CVE-1", "a", "CRITICAL"), f("CVE-2", "b", "HIGH")], truncated: true }
    const next = [f("CVE-7", "x", "CRITICAL"), f("CVE-8", "y", "HIGH"), f("CVE-9", "z", "MEDIUM")]
    expect(newFindings(previous, next, "LOW").map(findingKey)).toEqual(["CVE-7|x"])
  })
})

describe("vulnerability alerts", () => {
  it("names the image, counts and each finding", () => {
    const fresh = [
      { ...f("CVE-2021-36159", "apk-tools", "CRITICAL"), installed: "2.10.6-r0", fixed: "2.10.7-r0" },
      f("CVE-2", "b", "HIGH"),
    ]
    const alert = vulnerabilityAlert("alpine:3.10", fresh)
    expect(alert.subject).toBe("alpine:3.10: 2 new vulnerabilities (1 critical, 1 high)")
    expect(alert.message).toBe("CVE-2021-36159 [critical] apk-tools 2.10.6-r0 → fixed in 2.10.7-r0\nCVE-2 [high] b 1 (no fix yet)")
    expect(vulnerabilityAlert("x", [fresh[1]]).subject).toBe("x: 1 new vulnerability (1 high)")
    const many = Array.from({ length: 20 }, (_, i) => f(`CVE-${i}`, "p", "LOW"))
    expect(vulnerabilityAlert("x", many).message.split("\n")).toHaveLength(16)
    expect(describeCounts(many)).toBe("20 low")
  })
})

describe("scanner helpers", () => {
  it("reads the first file of a tar archive and builds directory entries", () => {
    expect(firstTarFile(singleFileTar("report.json", '{"a":1}'))?.toString()).toBe('{"a":1}')
    const dirs = directoryTar(["scan/", "scan/image/"])
    expect(dirs.length).toBe(512 * 2 + 1024)
    expect(String.fromCharCode(dirs[156])).toBe("5")
    expect(dirs.subarray(512, 523).toString()).toBe("scan/image/")
    expect(firstTarFile(dirs)).toBeNull()
    expect(() => directoryTar(["../etc/"])).toThrow()
    expect(() => directoryTar(["no-slash"])).toThrow()
  })

  it("explains failures, offline hosts in particular", () => {
    const offline =
      '2026-10-31T06:33:16Z\tINFO\t[vulndb] Downloading vulnerability DB...\n2026-10-31T06:33:46Z\tFATAL\tFatal error\trun error: init error: DB error: failed to download vulnerability DB: OCI artifact error: dial tcp: lookup mirror.gcr.io: no such host'
    expect(trivyFailure(offline, 1)).toMatch(/^Trivy couldn't download its vulnerability database/)
    expect(trivyFailure(offline, 1)).toContain("TRIVY_DB_REPOSITORY")
    expect(trivyFailure("2026-10-31T06:33:16Z\tFATAL\tFatal error\tunable to analyze image", 1)).toBe(
      "Trivy failed (exit code 1): Fatal error unable to analyze image"
    )
    expect(trivyFailure("", 137)).toBe("Trivy failed (exit code 137)")
  })
})
