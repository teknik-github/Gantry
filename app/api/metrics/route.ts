import type { NextRequest } from "next/server"

import { authorizeRequest } from "@/lib/server/api-auth"
import { getDb } from "@/lib/server/db"
import { getCurrentEnvironment } from "@/lib/server/environments"
import {
  downsample,
  isMetricRange,
  METRIC_RANGES,
  metricsConfig,
  type MetricPoint,
  type MetricRange,
} from "@/lib/server/metrics"

export type MetricsResponse = {
  range: MetricRange
  from: number
  to: number
  /** Sampling interval of the background sampler. */
  intervalMs: number
  points: MetricPoint[]
}

const MAX_POINTS = 300

/** Recorded resource usage of the current environment: GET /api/metrics?range=1h|24h|7d */
export async function GET(request: NextRequest) {
  const auth = await authorizeRequest("view")
  if (auth.response) return auth.response

  const range = request.nextUrl.searchParams.get("range") ?? "1h"
  if (!isMetricRange(range)) {
    return Response.json({ error: `range must be one of ${Object.keys(METRIC_RANGES).join(", ")}` }, { status: 400 })
  }

  const env = await getCurrentEnvironment()
  if (!env) return Response.json({ error: "No Docker environment configured" }, { status: 404 })

  const to = Date.now()
  const from = to - METRIC_RANGES[range]
  const db = await getDb()
  const rows = await db
    .selectFrom("metrics")
    .select(["ts", "containers", "cpu", "mem_used", "mem_total"])
    .where("environment_id", "=", env.id)
    .where("ts", ">=", new Date(from).toISOString())
    .orderBy("ts")
    .execute()

  const { intervalMs } = metricsConfig()
  const body: MetricsResponse = {
    range,
    from,
    to,
    intervalMs,
    points: downsample(
      rows.map((r) => ({
        ts: Date.parse(r.ts),
        cpu: Number(r.cpu),
        memory: Number(r.mem_used),
        memTotal: Number(r.mem_total),
        containers: Number(r.containers),
      })),
      { from, to, maxPoints: MAX_POINTS, gapMs: 3 * intervalMs }
    ),
  }
  return Response.json(body, { headers: { "Cache-Control": "no-store" } })
}
