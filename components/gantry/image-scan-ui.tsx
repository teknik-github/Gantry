"use client"

import * as React from "react"
import { useActionState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ExternalLinkIcon, Loader2Icon, PlayIcon, SaveIcon, ScanSearchIcon, ShieldCheckIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { saveScanSettings, scanImages, scanImagesInUseNow } from "@/app/(app)/images/scan-actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { BulkButton } from "@/components/gantry/bulk"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { Mono } from "@/components/gantry/ui"
import { submitKeepingValues, useRunAction } from "@/components/gantry/use-action"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  ALERT_SEVERITIES,
  imageScanPath,
  SEVERITIES,
  SEVERITY_LABELS,
  severityRank,
  totalCount,
  type AlertSeverity,
  type Finding,
  type ScanSummary,
  type Severity,
  type SeverityCounts,
} from "@/lib/image-scan"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import type { ActionState } from "@/lib/validation"

// Image vulnerability scans in the UI: the "Vulnerabilities" column of the
// Images table (live while scans run), scan buttons, the findings view and
// the administrators' settings card.

export const SEVERITY_CLASSES: Record<Severity, string> = {
  CRITICAL: "border-transparent bg-destructive text-white",
  HIGH: "border-transparent bg-rust text-white",
  MEDIUM: "border-transparent bg-crane text-dock",
  LOW: "border-steel/40 text-steel",
  UNKNOWN: "text-muted-foreground",
}

const SEVERITY_DOTS: Record<Severity, string> = {
  CRITICAL: "bg-destructive",
  HIGH: "bg-rust",
  MEDIUM: "bg-crane",
  LOW: "bg-steel",
  UNKNOWN: "bg-muted-foreground",
}

const POLL_MS = 2_500

type ScanContextValue = { get: (imageId: string) => ScanSummary | undefined; watch: () => void }
const ScanContext = React.createContext<ScanContextValue>({ get: () => undefined, watch: () => {} })

function toMap(list: ScanSummary[]) {
  return new Map(list.map((s) => [s.imageId, s]))
}

/**
 * Scan state of the environment's images for the table below it. Polls
 * /api/image-scans while scans are queued or running (and shortly after one
 * was requested), so badges update without reloading the slow image list.
 */
export function ScanStatusProvider({ initial, children }: { initial: ScanSummary[]; children: React.ReactNode }) {
  const environmentId = useEnvironmentId()
  const [scans, setScans] = React.useState(() => toMap(initial))
  const [seen, setSeen] = React.useState(initial)
  // A router refresh brings new server data: start from it.
  if (seen !== initial) {
    setSeen(initial)
    setScans(toMap(initial))
  }
  const [watchUntil, setWatchUntil] = React.useState(0)
  const pending = [...scans.values()].some((s) => s.pending)

  React.useEffect(() => {
    if (!pending && watchUntil === 0) return
    let cancelled = false
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/image-scans?environment=${environmentId ?? ""}`, { cache: "no-store" })
        if (!res.ok || cancelled) return
        const data = (await res.json()) as { scans: ScanSummary[] }
        if (cancelled) return
        setScans(toMap(data.scans))
        if (!data.scans.some((s) => s.pending) && Date.now() > watchUntil) {
          clearInterval(timer)
          setWatchUntil(0)
        }
      } catch {
        // Offline for a moment: try again on the next tick.
      }
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pending, watchUntil, environmentId])

  const value = React.useMemo<ScanContextValue>(
    () => ({ get: (id) => scans.get(id), watch: () => setWatchUntil(Date.now() + 15_000) }),
    [scans]
  )
  return <ScanContext.Provider value={value}>{children}</ScanContext.Provider>
}

export function useImageScan(imageId: string) {
  return React.useContext(ScanContext).get(imageId)
}

/** Count badges per severity (Critical, High, Medium, Low; Unknown when any). */
export function SeverityBadges({ counts, className }: { counts: SeverityCounts; className?: string }) {
  const { t } = useI18n()
  if (totalCount(counts) === 0) {
    return (
      <Badge variant="outline" className="border-sea/40 text-sea" data-testid="vuln-none">
        <ShieldCheckIcon />
        {t.images.scan.noVulnerabilities}
      </Badge>
    )
  }
  return (
    <span className={`flex flex-wrap items-center gap-1 ${className ?? ""}`} data-testid="vuln-badges">
      {SEVERITIES.filter((s) => s !== "UNKNOWN" || counts.UNKNOWN > 0).map((s) => (
        <Badge
          key={s}
          variant="outline"
          className={`px-1.5 tabular-nums ${counts[s] ? SEVERITY_CLASSES[s] : "text-muted-foreground opacity-50"}`}
          title={`${counts[s]} ${SEVERITY_LABELS[s].toLowerCase()}`}
          data-testid={`vuln-${s.toLowerCase()}`}
          data-count={counts[s]}
        >
          <span aria-hidden>{SEVERITY_LABELS[s][0]}</span>
          <span>{counts[s]}</span>
          <span className="sr-only">{SEVERITY_LABELS[s].toLowerCase()}</span>
        </Badge>
      ))}
    </span>
  )
}

/** Scan state of one image: badges linking to the findings, or why there are none. */
export function ScanStatus({ summary, imageId, name }: { summary: ScanSummary | undefined; imageId: string; name: string }) {
  const i18n = useI18n()
  const text = i18n.t.images.scan
  if (summary?.pending === "running") {
    return (
      <Badge variant="outline" className="text-muted-foreground" title={summary.phase ?? undefined} data-testid="vuln-scanning">
        <Loader2Icon className="animate-spin" />
        {summary.phase?.startsWith("Pulling") ? summary.phase : text.scanning}
      </Badge>
    )
  }
  if (summary?.pending === "queued") {
    return (
      <Badge variant="outline" className="text-muted-foreground" data-testid="vuln-queued">
        {text.queued}
      </Badge>
    )
  }
  if (!summary) return <span className="text-sm text-muted-foreground">{text.notScanned}</span>
  const href = imageScanPath(imageId)
  if (!summary.scannedAt) {
    return (
      <Link href={href} title={summary.error ?? undefined} aria-label={i18n.format(text.errorFor, { name })}>
        <Badge variant="outline" className="border-destructive/50 text-destructive" data-testid="vuln-failed">
          <TriangleAlertIcon />
          {text.failed}
        </Badge>
      </Link>
    )
  }
  return (
    <span className="flex items-center gap-1.5">
      <Link href={href} aria-label={i18n.format(text.vulnerabilitiesOf, { name })} className="rounded-md hover:opacity-80">
        <SeverityBadges counts={summary.counts} />
      </Link>
      {summary.error ? (
        <TriangleAlertIcon className="size-4 text-destructive" aria-label={i18n.format(text.lastFailed, { error: summary.error })} />
      ) : null}
    </span>
  )
}

/** The "Vulnerabilities" cell of the Images table. */
export function VulnerabilityCell({ imageId, name }: { imageId: string; name: string }) {
  return <ScanStatus summary={useImageScan(imageId)} imageId={imageId} name={name} />
}

/** Row action: scan one image (operators and up). */
export function ScanImageButton({ imageId, name }: { imageId: string; name: string }) {
  const i18n = useI18n()
  const environmentId = useEnvironmentId()
  const { watch } = React.useContext(ScanContext)
  const busy = Boolean(useImageScan(imageId)?.pending)
  const [pending, run] = useRunAction()
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground"
      aria-label={i18n.format(i18n.t.images.scan.scanLabel, { name })}
      title={i18n.t.images.scan.scanTitle}
      disabled={pending || busy}
      onClick={async () => {
        if (await run(() => scanImages([{ id: imageId, name }], environmentId))) watch()
      }}
    >
      <ScanSearchIcon />
    </Button>
  )
}

/** Bulk action: scan the selected images. */
export function BulkScanImages({ selected, clear }: { selected: { id: string; name: string }[]; clear: () => void }) {
  const { t } = useI18n()
  const environmentId = useEnvironmentId()
  const { watch } = React.useContext(ScanContext)
  return (
    <BulkButton
      label={t.images.scan.scan}
      icon={<ScanSearchIcon data-icon="inline-start" />}
      count={selected.length}
      onRun={() => scanImages(selected, environmentId)}
      onDone={() => {
        watch()
        clear()
      }}
    />
  )
}

/** Administrators: daily scan of images in use and the alert threshold. */
export function ImageScanSettingsCard({
  enabled,
  time,
  minSeverity,
  serverTime,
  timeZone,
  scanner,
  lastRun,
}: {
  enabled: boolean
  time: string
  minSeverity: AlertSeverity
  serverTime: string
  timeZone: string
  scanner: string
  lastRun: string | null
}) {
  const i18n = useI18n()
  const { t } = i18n
  const text = t.images.scan
  const [state, formAction, saving] = useActionState<ActionState, FormData>(saveScanSettings, {})
  const saved = t.common.status.saved
  React.useEffect(() => {
    if (state.ok) toast.success(state.message ?? saved)
    else if (state.error && !state.fieldErrors) toast.error(state.error)
  }, [state, saved])
  const [runPending, run] = useRunAction()
  const uid = React.useId()

  return (
    <div className="px-4 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{text.settingsTitle}</CardTitle>
          <CardDescription>
            {i18n.format(text.settingsDescription, { scanner, time: serverTime, timeZone })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* No automatic form reset: Radix Select/Checkbox would jump back to their first values. */}
          <form method="post" onSubmit={submitKeepingValues(formAction)} className="flex flex-wrap items-end gap-4">
            <Label className="h-8 font-normal">
              <Checkbox name="enabled" value="on" defaultChecked={enabled} />
              {text.daily}
            </Label>
            <Field data-invalid={state.fieldErrors?.time ? true : undefined} className="w-32">
              <FieldLabel htmlFor={`${uid}-time`}>{text.at}</FieldLabel>
              <Input id={`${uid}-time`} name="time" type="time" defaultValue={time} required />
              <FieldError>{state.fieldErrors?.time?.[0]}</FieldError>
            </Field>
            <Field data-invalid={state.fieldErrors?.minSeverity ? true : undefined} className="w-44">
              <FieldLabel htmlFor={`${uid}-severity`}>{text.alertFrom}</FieldLabel>
              <Select name="minSeverity" defaultValue={minSeverity}>
                <SelectTrigger id={`${uid}-severity`} aria-label={text.alertFrom}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALERT_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s === "CRITICAL" ? SEVERITY_LABELS[s] : i18n.format(text.andUp, { severity: SEVERITY_LABELS[s] })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError>{state.fieldErrors?.minSeverity?.[0]}</FieldError>
            </Field>
            <Button type="submit" variant="outline" disabled={saving}>
              <SaveIcon data-icon="inline-start" />
              {saving ? t.common.status.saving : t.common.actions.save}
            </Button>
            <Button type="button" disabled={runPending} onClick={() => run(scanImagesInUseNow)}>
              <PlayIcon data-icon="inline-start" />
              {text.scanInUseNow}
            </Button>
          </form>
          <FieldDescription className="mt-3">
            {text.settingsHelp}
            {lastRun ? ` ${lastRun}` : ""}
          </FieldDescription>
        </CardContent>
      </Card>
    </div>
  )
}

/** Scan again from the findings page, then follow the scan until it is done. */
export function RescanButton({
  imageId,
  name,
  pending: initiallyPending,
}: {
  imageId: string
  name: string
  pending: boolean
}) {
  const { t } = useI18n()
  const queued = t.images.scan.queued
  const router = useRouter()
  const environmentId = useEnvironmentId()
  const [pending, run] = useRunAction()
  const [following, setFollowing] = React.useState(initiallyPending)
  const [phase, setPhase] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!following) return
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/image-scans?environment=${environmentId ?? ""}`, { cache: "no-store" })
        if (!res.ok) return
        const data = (await res.json()) as { scans: ScanSummary[] }
        const mine = data.scans.find((s) => s.imageId === imageId)
        setPhase(mine?.pending === "queued" ? queued : (mine?.phase ?? null))
        if (!mine?.pending) {
          clearInterval(timer)
          setFollowing(false)
          setPhase(null)
          router.refresh()
        }
      } catch {}
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [following, environmentId, imageId, router, queued])

  const busy = pending || following
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={async () => {
        if (await run(() => scanImages([{ id: imageId, name }], environmentId))) setFollowing(true)
      }}
    >
      {busy ? <Loader2Icon data-icon="inline-start" className="animate-spin" /> : <ScanSearchIcon data-icon="inline-start" />}
      {busy ? (phase ?? t.images.scan.scanning) : t.images.scan.scanNow}
    </Button>
  )
}

type FindingRow = Finding & { key: string }

const helper = columnHelperFor<FindingRow>()
const buildColumns = (t: I18n["t"]) => helper.columns([
  helper.accessor((r) => severityRank(r.severity), {
    id: "severity",
    header: ({ column }) => <SortHeader column={column} title={t.images.findings.columns.severity} />,
    cell: ({ row }) => (
      <Badge variant="outline" className={SEVERITY_CLASSES[row.original.severity]}>
        {SEVERITY_LABELS[row.original.severity]}
      </Badge>
    ),
    enableHiding: false,
  }),
  helper.accessor("id", {
    header: ({ column }) => <SortHeader column={column} title={t.images.findings.columns.vulnerability} />,
    cell: ({ row }) =>
      row.original.url ? (
        <a
          href={row.original.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 font-mono text-xs underline-offset-4 hover:underline"
        >
          {row.original.id}
          <ExternalLinkIcon className="size-3" />
        </a>
      ) : (
        <Mono>{row.original.id}</Mono>
      ),
    enableHiding: false,
  }),
  helper.accessor("pkg", {
    header: ({ column }) => <SortHeader column={column} title={t.images.findings.columns.package} />,
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="font-medium">{row.original.pkg}</span>
        {row.original.target ? <span className="max-w-60 truncate text-xs text-muted-foreground">{row.original.target}</span> : null}
      </div>
    ),
  }),
  helper.accessor("installed", { header: t.images.findings.columns.installed, cell: ({ row }) => <Mono>{row.original.installed || "—"}</Mono> }),
  helper.accessor("fixed", {
    header: t.images.findings.columns.fixed,
    cell: ({ row }) =>
      row.original.fixed ? (
        <Mono className="text-sea">{row.original.fixed}</Mono>
      ) : (
        <span className="text-xs text-muted-foreground">{t.images.findings.noFix}</span>
      ),
  }),
  helper.accessor("title", {
    header: t.images.findings.columns.title,
    cell: ({ row }) => <span className="line-clamp-2 max-w-md text-xs text-muted-foreground">{row.original.title || "—"}</span>,
  }),
])

/** Findings with a severity filter, a "fixable only" switch and a search. */
export function FindingsTable({ findings }: { findings: Finding[] }) {
  const { t } = useI18n()
  const text = t.images.findings
  const columns = React.useMemo(() => buildColumns(t), [t])
  const uid = React.useId()
  const present = SEVERITIES.filter((s) => findings.some((f) => f.severity === s))
  const [severities, setSeverities] = React.useState<string[]>(present)
  const [fixable, setFixable] = React.useState(false)
  const rows = React.useMemo(
    () =>
      findings
        .filter((f) => severities.includes(f.severity) && (!fixable || f.fixed))
        .map((f, i) => ({ ...f, key: `${f.id}|${f.pkg}|${f.installed}|${i}` })),
    [findings, severities, fixable]
  )
  const counts = (s: Severity) => findings.filter((f) => f.severity === s && (!fixable || f.fixed)).length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4 px-4 lg:px-6">
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          value={severities}
          onValueChange={setSeverities}
          aria-label={text.severityFilter}
        >
          {present.map((s) => (
            <ToggleGroupItem key={s} value={s} aria-label={`${SEVERITY_LABELS[s]} (${counts(s)})`} className="gap-1.5">
              <span className={`size-2 rounded-full ${SEVERITY_DOTS[s]}`} />
              {SEVERITY_LABELS[s]}
              <span className="tabular-nums text-muted-foreground">{counts(s)}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Label htmlFor={`${uid}-fixable`} className="font-normal">
          <Switch id={`${uid}-fixable`} checked={fixable} onCheckedChange={setFixable} />
          {text.fixableOnly}
        </Label>
      </div>
      <DataTable
        data={rows}
        columns={columns}
        getRowId={(r) => r.key}
        searchText={(r) => `${r.id} ${r.pkg} ${r.title} ${r.target}`}
        searchPlaceholder={text.searchPlaceholder}
        emptyMessage={findings.length ? text.noMatch : text.none}
        columnLabels={{ pkg: text.columns.package, installed: text.columns.installed, fixed: text.columns.fixed, title: text.columns.title }}
        pageSize={25}
      />
    </div>
  )
}
