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
import { formatBytes } from "@/lib/format"

const POLL_MS = 5_000
const MAX_SAMPLES = 720 // one hour at 5s
const MIN_HISTORY_REFRESH_MS = 30_000

type Point = { ts: number; cpu: number | null; memory: number | null }
type Metric = "cpu" | "memory"

const chartConfig = {
  cpu: { label: "CPU", color: "var(--chart-1)" },
  memory: { label: "Memory", color: "var(--chart-2)" },
} satisfies ChartConfig

const RANGES = {
  live: { label: "Live" },
  "1h": { label: "1 hour" },
  "24h": { label: "24 hours" },
  "7d": { label: "7 days" },
} as const
type RangeKey = keyof typeof RANGES
type HistoryRange = Exclude<RangeKey, "live">

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
const minuteFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" })
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" })
const fullFmt = new Intl.DateTimeFormat("en-GB", {
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

const formatValue = (metric: Metric, v: number, digits = 1) =>
  metric === "cpu" ? `${v.toFixed(digits)}%` : formatBytes(v)

/**
 * CPU / memory usage of running containers in the current environment.
 * "Live" polls /api/stats while the dashboard is open; the other ranges show
 * the history recorded by the server-side sampler (/api/metrics).
 */
export function ChartAreaInteractive() {
  const router = useRouter()
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
          setLiveError(body.error ?? "Failed to load stats")
        } else {
          const s = body as StatsResponse
          setLiveError(null)
          setLatest(s)
          setSamples((prev) => [...prev, { ts: s.ts, cpu: s.cpu, memory: s.memory }].slice(-MAX_SAMPLES))
        }
      } catch {
        if (!cancelled) setLiveError("Failed to load stats")
      }
      if (!cancelled) timer = setTimeout(poll, document.hidden ? POLL_MS * 3 : POLL_MS)
    }

    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [range, router])

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
          setHistoryError({ range: range as HistoryRange, message: body.error ?? "Failed to load history" })
        } else {
          const h = body as MetricsResponse
          setHistoryError(null)
          setHistory(h)
          next = h.intervalMs
        }
      } catch {
        if (!cancelled) setHistoryError({ range: range as HistoryRange, message: "Failed to load history" })
      }
      if (!cancelled) timer = setTimeout(load, Math.max(MIN_HISTORY_REFRESH_MS, next))
    }

    load()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [range, router])

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
          ? `${latest.cpu.toFixed(1)}% of ${latest.ncpu} CPU`
          : `${formatBytes(latest.memory)} of ${formatBytes(latest.memTotal)}`
  } else if (historyLoading) {
    summary = "Loading history…"
  } else if (values.length === 0) {
    summary = "No samples recorded yet"
  } else {
    const avg = values.reduce((a, v) => a + v, 0) / values.length
    const peak = Math.max(...values)
    const memTotal = currentHistory?.points.findLast((p) => p.memTotal !== null)?.memTotal
    summary = `avg ${formatValue(metric, avg)} · peak ${formatValue(metric, peak)}`
    if (metric === "memory" && memTotal) summary += ` of ${formatBytes(memTotal)}`
  }

  const prefix = isLive
    ? latest
      ? `${latest.running ?? latest.containers.length} running container(s) · `
      : ""
    : `Last ${RANGES[range].label} · `

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Resource usage</CardTitle>
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
            <ToggleGroupItem value="cpu">CPU</ToggleGroupItem>
            <ToggleGroupItem value="memory">Memory</ToggleGroupItem>
          </ToggleGroup>
          <Select value={range} onValueChange={(v) => setRange(v as RangeKey)}>
            <SelectTrigger
              className="w-28 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[540px]/card:w-32"
              size="sm"
              aria-label="Time range"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              {Object.entries(RANGES).map(([key, r]) => (
                <SelectItem key={key} value={key} className="rounded-lg">
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="relative px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
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
              tickFormatter={(v: number) => (metric === "cpu" ? `${v.toFixed(0)}%` : formatBytes(v, 0))}
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
                      {formatValue(metric, Number(value), 2)}
                      {isLive || range === "1h" ? "" : " avg"}
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
            <span className="font-medium">Collecting history…</span>
            <span className="max-w-xs text-muted-foreground">
              Usage is recorded every {Math.round((currentHistory?.intervalMs ?? 60_000) / 1000)}s. Check back in a
              few minutes, or switch to Live.
            </span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
