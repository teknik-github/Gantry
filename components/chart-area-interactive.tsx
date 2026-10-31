"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import type { MetricsResponse } from "@/app/api/metrics/route"
import type { StatsResponse } from "@/app/api/stats/route"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { I18n, Locale } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import { INTL_LOCALES } from "@/lib/i18n/config"

const POLL_MS = 5_000
const MAX_SAMPLES = 720 // one hour at 5s
const MIN_HISTORY_REFRESH_MS = 30_000

type Point = { ts: number; cpu: number | null; memory: number | null }
type Metric = "cpu" | "memory"

const chartConfig = (t: I18n["t"]) =>
  ({
    cpu: { label: t.dashboard.chart.cpu, color: "var(--chart-1)" },
    memory: { label: t.dashboard.chart.memory, color: "var(--chart-2)" },
  }) satisfies ChartConfig

const RANGES = ["live", "1h", "24h", "7d"] as const
type RangeKey = (typeof RANGES)[number]
type HistoryRange = Exclude<RangeKey, "live">

/** Time formats of the axis and tooltip, per language (English keeps en-GB). */
function dateFormats(locale: Locale) {
  const tag = INTL_LOCALES[locale].dates
  const timeFmt = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
  const minuteFmt = new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" })
  const dayFmt = new Intl.DateTimeFormat(tag, { day: "numeric", month: "short" })
  const fullFmt = new Intl.DateTimeFormat(tag, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
  const tickFormat: Record<RangeKey, (ts: number) => string> = {
    live: (ts) => timeFmt.format(ts),
    "1h": (ts) => minuteFmt.format(ts),
    "24h": (ts) => minuteFmt.format(ts),
    "7d": (ts) => dayFmt.format(ts),
  }
  return { timeFmt, fullFmt, tickFormat }
}

/** A fixed number of decimals (like toFixed) in the language's number format. */
const fixed = (i18n: I18n, v: number, digits: number) =>
  i18n.formatNumber(v, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })

const formatValue = (i18n: I18n, metric: Metric, v: number, digits = 1) =>
  metric === "cpu" ? `${fixed(i18n, v, digits)}%` : i18n.formatBytes(v)

/**
 * CPU / memory usage of running containers in the current environment.
 * "Live" polls /api/stats while the dashboard is open; the other ranges show
 * the history recorded by the server-side sampler (/api/metrics).
 */
export function ChartAreaInteractive() {
  const router = useRouter()
  const i18n = useI18n()
  const text = i18n.t.dashboard.chart
  const config = React.useMemo(() => chartConfig(i18n.t), [i18n.t])
  const { timeFmt, fullFmt, tickFormat } = React.useMemo(() => dateFormats(i18n.locale), [i18n.locale])
  const [metric, setMetric] = React.useState<Metric>("cpu")
  const [range, setRange] = React.useState<RangeKey>("live")

  // Live samples, collected in the browser.
  const [samples, setSamples] = React.useState<Point[]>([])
  const [latest, setLatest] = React.useState<StatsResponse | null>(null)
  const [liveError, setLiveError] = React.useState<string | null>(null)

  // History, tagged with the range it belongs to so a stale response is never shown.
  const [history, setHistory] = React.useState<MetricsResponse | null>(null)
  const [historyError, setHistoryError] = React.useState<{ range: HistoryRange; message: string } | null>(null)

  React.useEffect(() => {
    if (range !== "live") return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    async function poll() {
      try {
        const res = await fetch("/api/stats", { cache: "no-store" })
        if (res.status === 401) return router.replace("/login")
        const body = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setLiveError(body.error ?? text.statsFailed)
        } else {
          const s = body as StatsResponse
          setLiveError(null)
          setLatest(s)
          setSamples((prev) => [...prev, { ts: s.ts, cpu: s.cpu, memory: s.memory }].slice(-MAX_SAMPLES))
        }
      } catch {
        if (!cancelled) setLiveError(text.statsFailed)
      }
      if (!cancelled) timer = setTimeout(poll, document.hidden ? POLL_MS * 3 : POLL_MS)
    }

    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [range, router, text.statsFailed])

  React.useEffect(() => {
    if (range === "live") return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    async function load() {
      let next = 60_000
      try {
        const res = await fetch(`/api/metrics?range=${range}`, { cache: "no-store" })
        if (res.status === 401) return router.replace("/login")
        const body = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setHistoryError({ range: range as HistoryRange, message: body.error ?? text.historyFailed })
        } else {
          const h = body as MetricsResponse
          setHistoryError(null)
          setHistory(h)
          next = h.intervalMs
        }
      } catch {
        if (!cancelled) setHistoryError({ range: range as HistoryRange, message: text.historyFailed })
      }
      if (!cancelled) timer = setTimeout(load, Math.max(MIN_HISTORY_REFRESH_MS, next))
    }

    load()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [range, router, text.historyFailed])

  const isLive = range === "live"
  const currentHistory = !isLive && history?.range === range ? history : null
  const error = isLive ? liveError : historyError?.range === range ? historyError.message : null

  let data: Point[]
  let domain: [number | string, number | string] = ["dataMin", "dataMax"]
  if (isLive) {
    data = samples
  } else {
    data = currentHistory?.points ?? []
    if (currentHistory) domain = [currentHistory.from, currentHistory.to]
  }

  const values = data.map((p) => p[metric]).filter((v): v is number => v !== null)
  const historyLoading = !isLive && !currentHistory && !error
  const collecting = !isLive && currentHistory !== null && values.length < 2

  let summary: string
  if (isLive) {
    summary =
      latest === null
        ? "—"
        : metric === "cpu"
          ? i18n.format(text.cpuOf, { value: fixed(i18n, latest.cpu, 1), ncpu: latest.ncpu })
          : i18n.format(text.memoryOf, { value: i18n.formatBytes(latest.memory), total: i18n.formatBytes(latest.memTotal) })
  } else if (historyLoading) {
    summary = text.loadingHistory
  } else if (values.length === 0) {
    summary = text.noSamples
  } else {
    const avg = values.reduce((a, v) => a + v, 0) / values.length
    const peak = Math.max(...values)
    const memTotal = currentHistory?.points.findLast((p) => p.memTotal !== null)?.memTotal
    const stats = { avg: formatValue(i18n, metric, avg), peak: formatValue(i18n, metric, peak) }
    summary =
      metric === "memory" && memTotal
        ? i18n.format(text.avgPeakOf, { ...stats, total: i18n.formatBytes(memTotal) })
        : i18n.format(text.avgPeak, stats)
  }

  const prefix = isLive
    ? latest
      ? `${i18n.format(text.runningContainers, { count: latest.running ?? latest.containers.length })} · `
      : ""
    : `${i18n.format(text.last, { range: text.ranges[range] })} · `

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>{text.title}</CardTitle>
        <CardDescription>
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : (
            <>
              <span className="hidden @[540px]/card:inline">{prefix}</span>
              {summary}
            </>
          )}
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            value={metric}
            onValueChange={(v) => v && setMetric(v as Metric)}
            variant="outline"
            className="*:data-[slot=toggle-group-item]:px-3!"
          >
            <ToggleGroupItem value="cpu">{text.cpu}</ToggleGroupItem>
            <ToggleGroupItem value="memory">{text.memory}</ToggleGroupItem>
          </ToggleGroup>
          <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
            <SelectTrigger
              className="w-28 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[540px]/card:w-32"
              size="sm"
              aria-label={text.timeRange}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              {RANGES.map((key) => (
                <SelectItem key={key} value={key} className="rounded-lg">
                  {text.ranges[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="relative px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer config={config} className="aspect-auto h-[250px] w-full">
          <AreaChart data={data}>
            <defs>
              <linearGradient id="fillMetric" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={`var(--color-${metric})`} stopOpacity={0.8} />
                <stop offset="95%" stopColor={`var(--color-${metric})`} stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={domain}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={48}
              tickFormatter={(v) => tickFormat[range](v)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={64}
              tickFormatter={(v: number) => (metric === "cpu" ? `${fixed(i18n, v, 0)}%` : i18n.formatBytes(v, 0))}
            />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(_, payload) => {
                    const ts = payload?.[0]?.payload?.ts
                    return ts ? (isLive ? timeFmt : fullFmt).format(ts) : ""
                  }}
                  formatter={(value) => (
                    <span className="font-mono font-medium tabular-nums">
                      {formatValue(i18n, metric, Number(value), 2)}
                      {isLive || range === "1h" ? "" : ` ${text.avg}`}
                    </span>
                  )}
                  indicator="dot"
                />
              }
            />
            <Area
              dataKey={metric}
              type="monotone"
              fill="url(#fillMetric)"
              stroke={`var(--color-${metric})`}
              isAnimationActive={false}
              connectNulls={false}
            />
          </AreaChart>
        </ChartContainer>
        {collecting ? (
          <div
            data-testid="metrics-empty"
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-sm"
          >
            <span className="font-medium">{text.collecting}</span>
            <span className="max-w-xs text-muted-foreground">
              {i18n.format(text.collectingHelp, { seconds: Math.round((currentHistory?.intervalMs ?? 60_000) / 1000) })}
            </span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
