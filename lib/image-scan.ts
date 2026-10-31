// Pure helpers for image vulnerability scans (Trivy): severities, parsing a
// Trivy JSON report into findings, and which findings are new since the
// previous scan. Shared by the server (lib/server/image-scans.ts) and the UI;
// nothing here touches Docker or the database.

export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const
export type Severity = (typeof SEVERITIES)[number]

/** Severities an alert threshold can be set to (most severe first). */
export const ALERT_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const satisfies readonly Severity[]
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

export const SEVERITY_LABELS: Record<Severity, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  UNKNOWN: "Unknown",
}

/** Higher is worse. */
const RANK: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 }

export function severityRank(s: Severity) {
  return RANK[s]
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)
}

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return typeof value === "string" && (ALERT_SEVERITIES as readonly string[]).includes(value)
}

export function toSeverity(value: unknown): Severity {
  const upper = typeof value === "string" ? value.toUpperCase() : ""
  return isSeverity(upper) ? upper : "UNKNOWN"
}

export type SeverityCounts = Record<Severity, number>

export function emptyCounts(): SeverityCounts {
  return { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 }
}

/** One vulnerability in one package. */
export type Finding = {
  /** CVE / GHSA / ALPINE-... id. */
  id: string
  pkg: string
  installed: string
  /** Empty when no fixed version is known. */
  fixed: string
  severity: Severity
  title: string
  /** Advisory link (Trivy's PrimaryURL); empty when none. */
  url: string
  /** Where Trivy found the package, e.g. "alpine:3.10 (alpine 3.10.9)" or "usr/local/bin/app". */
  target: string
}

/** Most findings stored per image; the rest are counted but dropped (least severe first). */
export const MAX_FINDINGS = 3000
const MAX_TEXT = { id: 64, pkg: 200, installed: 120, fixed: 200, title: 300, url: 500, target: 200 }

export type ParsedReport = {
  findings: Finding[]
  /** Distinct findings per severity, including those beyond MAX_FINDINGS. */
  counts: SeverityCounts
  /** Some findings were dropped to stay under MAX_FINDINGS. */
  truncated: boolean
  /** e.g. "alpine 3.10.9" when Trivy detected the OS. */
  os: string | null
}

export class ReportError extends Error {}

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "")

const safeUrl = (value: unknown) => {
  const url = clip(value, MAX_TEXT.url)
  return /^https?:\/\//i.test(url) ? url : ""
}

/** Two findings are the same vulnerability in the same package (versions may move between scans). */
export function findingKey(f: Pick<Finding, "id" | "pkg">) {
  return `${f.id}|${f.pkg}`
}

/** Most severe first, then by id and package, so lists and caps are stable. */
export function compareFindings(a: Finding, b: Finding) {
  return RANK[b.severity] - RANK[a.severity] || a.id.localeCompare(b.id) || a.pkg.localeCompare(b.pkg) || a.target.localeCompare(b.target)
}

type TrivyVulnerability = {
  VulnerabilityID?: unknown
  PkgName?: unknown
  PkgID?: unknown
  InstalledVersion?: unknown
  FixedVersion?: unknown
  Severity?: unknown
  Title?: unknown
  Description?: unknown
  PrimaryURL?: unknown
}

/**
 * Turns a Trivy JSON report (`trivy image --format json`) into findings.
 * The same vulnerability of the same package version found in several
 * places (targets) is listed once. Throws ReportError when the input isn't
 * a Trivy report. `inputPath` (the --input of the scan) is dropped from
 * target names.
 */
export function parseTrivyReport(
  report: unknown,
  { maxFindings = MAX_FINDINGS, inputPath }: { maxFindings?: number; inputPath?: string } = {}
): ParsedReport {
  if (!report || typeof report !== "object" || Array.isArray(report)) throw new ReportError("Not a Trivy JSON report")
  const r = report as { SchemaVersion?: unknown; Results?: unknown; Metadata?: { OS?: { Family?: unknown; Name?: unknown } } }
  if (r.SchemaVersion === undefined && r.Results === undefined) throw new ReportError("Not a Trivy JSON report")
  const results = Array.isArray(r.Results) ? r.Results : []

  const seen = new Map<string, Finding>()
  for (const result of results) {
    if (!result || typeof result !== "object") continue
    const { Target, Vulnerabilities } = result as { Target?: unknown; Vulnerabilities?: unknown }
    if (!Array.isArray(Vulnerabilities)) continue
    let target = clip(Target, MAX_TEXT.target)
    // The OS packages target is named after the --input path: "/scan/image (alpine 3.10.9)".
    if (inputPath && target.startsWith(inputPath)) target = target.slice(inputPath.length).trim().replace(/^\((.*)\)$/, "$1") || "image"
    for (const v of Vulnerabilities as TrivyVulnerability[]) {
      if (!v || typeof v !== "object") continue
      const id = clip(v.VulnerabilityID, MAX_TEXT.id)
      const pkg = clip(v.PkgName, MAX_TEXT.pkg) || clip(v.PkgID, MAX_TEXT.pkg)
      if (!id || !pkg) continue
      const finding: Finding = {
        id,
        pkg,
        installed: clip(v.InstalledVersion, MAX_TEXT.installed),
        fixed: clip(v.FixedVersion, MAX_TEXT.fixed),
        severity: toSeverity(v.Severity),
        title: clip(v.Title, MAX_TEXT.title) || clip(v.Description, MAX_TEXT.title),
        url: safeUrl(v.PrimaryURL),
        target,
      }
      const key = `${findingKey(finding)}|${finding.installed}`
      if (!seen.has(key)) seen.set(key, finding)
    }
  }

  const all = [...seen.values()].sort(compareFindings)
  const counts = emptyCounts()
  for (const f of all) counts[f.severity]++
  const family = clip(r.Metadata?.OS?.Family, 40)
  const name = clip(r.Metadata?.OS?.Name, 40)
  return {
    findings: all.slice(0, Math.max(0, maxFindings)),
    counts,
    truncated: all.length > maxFindings,
    os: family ? `${family}${name ? ` ${name}` : ""}` : null,
  }
}

export function totalCount(counts: SeverityCounts) {
  return SEVERITIES.reduce((sum, s) => sum + counts[s], 0)
}

/**
 * Findings of `next` at or above `min` that the previous scan of the same
 * image didn't have (by vulnerability id + package). With no previous scan,
 * every finding at or above `min` is new.
 *
 * When the previous findings were truncated (only the most severe kept),
 * the least severe level it still listed may be incomplete, so findings at
 * that level or below are not reported as new: better a missed repeat than
 * the same alert every day.
 */
export function newFindings(
  previous: { findings: Finding[]; truncated: boolean } | null,
  next: Finding[],
  min: AlertSeverity
): Finding[] {
  const threshold = RANK[min]
  const atLeast = next.filter((f) => RANK[f.severity] >= threshold)
  if (!previous) return atLeast
  const known = new Set(previous.findings.map(findingKey))
  // Rank above which the previous list is complete.
  const complete = previous.truncated
    ? Math.min(...previous.findings.map((f) => RANK[f.severity]), RANK.CRITICAL + 1)
    : -1
  const fresh: Finding[] = []
  const added = new Set<string>()
  for (const f of atLeast) {
    const key = findingKey(f)
    if (known.has(key) || added.has(key)) continue
    if (previous.truncated && RANK[f.severity] <= complete) continue
    added.add(key)
    fresh.push(f)
  }
  return fresh
}

/** "3 critical, 1 high" for the severities at or above `min` (counts of `findings`). */
export function describeCounts(findings: Pick<Finding, "severity">[]) {
  const counts = emptyCounts()
  for (const f of findings) counts[f.severity]++
  return SEVERITIES.filter((s) => counts[s])
    .map((s) => `${counts[s]} ${SEVERITY_LABELS[s].toLowerCase()}`)
    .join(", ")
}

const ALERT_LINES = 15

/** Subject and message of a "vulnerability" alert for new findings of one image. */
export function vulnerabilityAlert(image: string, fresh: Finding[]) {
  const n = fresh.length
  const subject = `${image}: ${n} new vulnerabilit${n === 1 ? "y" : "ies"} (${describeCounts(fresh)})`
  const lines = fresh
    .slice(0, ALERT_LINES)
    .map((f) => `${f.id} [${SEVERITY_LABELS[f.severity].toLowerCase()}] ${f.pkg} ${f.installed}${f.fixed ? ` → fixed in ${f.fixed}` : " (no fix yet)"}`)
  if (n > ALERT_LINES) lines.push(`and ${n - ALERT_LINES} more`)
  return { subject, message: lines.join("\n") }
}

/** Scan state of an image for the UI. */
export type ScanSummary = {
  imageId: string
  reference: string
  /** ISO time of the last successful scan; null if none succeeded yet. */
  scannedAt: string | null
  counts: SeverityCounts
  /** Error of the last attempt (results above are from the scan before it). */
  error: string | null
  /** In the queue or running right now. */
  pending: "queued" | "running" | null
  /** What a running scan is doing ("Pulling scanner image 40%", "Scanning"...). */
  phase: string | null
}

/** Image ids in URLs: the hex part of "sha256:<hex>". */
export function imageScanPath(imageId: string) {
  return `/images/vulnerabilities/${imageId.replace(/^sha256:/, "")}`
}
