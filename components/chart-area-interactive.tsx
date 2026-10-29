"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

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

type Sample = { ts: number; cpu: number; memory: number }
type Metric = "cpu" | "memory"

const chartConfig = {
  cpu: { label: "CPU", color: "var(--primary)" },
  memory: { label: "Memory", color: "var(--primary)" },
} satisfies ChartConfig

const WINDOWS = {
  "5m": { label: "Last 5 minutes", ms: 5 * 60_000 },
  "15m": { label: "Last 15 minutes", ms: 15 * 60_000 },
  "60m": { label: "Last hour", ms: 60 * 60_000 },
} as const
type WindowKey = keyof typeof WINDOWS

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })

/**
 * Live CPU / memory usage of running containers in the current environment.
 * Samples are collected in the browser while the dashboard is open.
 */
export function ChartAreaInteractive() {
  const router = useRouter()
  const [samples, setSamples] = React.useState<Sample[]>([])
  const [latest, setLatest] = React.useState<StatsResponse | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [metric, setMetric] = React.useState<Metric>("cpu")
  const [windowKey, setWindowKey] = React.useState<WindowKey>("5m")

  React.useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    async function poll() {
      try {
        const res = await fetch("/api/stats", { cache: "no-store" })
        if (res.status === 401) return router.replace("/login")
        const body = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setError(body.error ?? "Failed to load stats")
        } else {
          const s = body as StatsResponse
          setError(null)
          setLatest(s)
          setSamples((prev) => [...prev, { ts: s.ts, cpu: s.cpu, memory: s.memory }].slice(-MAX_SAMPLES))
        }
      } catch {
        if (!cancelled) setError("Failed to load stats")
      }
      if (!cancelled) timer = setTimeout(poll, document.hidden ? POLL_MS * 3 : POLL_MS)
    }

    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [router])

  const cutoff = (samples.at(-1)?.ts ?? 0) - WINDOWS[windowKey].ms
  const data = samples.filter((s) => s.ts >= cutoff)

  const current =
    latest === null
      ? "—"
      : metric === "cpu"
        ? `${latest.cpu.toFixed(1)}% of ${latest.ncpu} CPU`
        : `${formatBytes(latest.memory)} of ${formatBytes(latest.memTotal)}`

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Resource usage</CardTitle>
        <CardDescription>
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : (
            <>
              <span className="hidden @[540px]/card:inline">
                {latest ? `${latest.containers.length} running container(s) · ` : ""}
              </span>
              {current}
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
          <Select value={windowKey} onValueChange={(v) => setWindowKey(v as WindowKey)}>
            <SelectTrigger
              className="hidden w-40 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[540px]/card:flex"
              size="sm"
              aria-label="Time window"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              {Object.entries(WINDOWS).map(([key, w]) => (
                <SelectItem key={key} value={key} className="rounded-lg">
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
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
              domain={["dataMin", "dataMax"]}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={48}
              tickFormatter={(v) => timeFmt.format(v)}
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
                    return ts ? timeFmt.format(ts) : ""
                  }}
                  formatter={(value) => (
                    <span className="font-mono font-medium tabular-nums">
                      {metric === "cpu" ? `${Number(value).toFixed(2)}%` : formatBytes(Number(value))}
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
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
