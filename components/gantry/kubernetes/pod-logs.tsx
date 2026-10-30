"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

/** Recent logs of one container of a pod, polled while auto-refresh is on. */
export function PodLogViewer({
  environmentId,
  namespace,
  name,
  containers,
}: {
  environmentId: number
  namespace: string
  name: string
  containers: string[]
}) {
  const router = useRouter()
  const [container, setContainer] = React.useState(containers[0] ?? "")
  const [logs, setLogs] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [tail, setTail] = React.useState("500")
  const [follow, setFollow] = React.useState(true)
  const [loading, setLoading] = React.useState(false)
  const [refreshKey, setRefreshKey] = React.useState(0)
  const preRef = React.useRef<HTMLPreElement>(null)

  React.useEffect(() => {
    let cancelled = false
    const query = new URLSearchParams({ tail, environment: String(environmentId) })
    if (container) query.set("container", container)
    const url = `/api/kubernetes/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/logs?${query}`

    async function load() {
      try {
        const res = await fetch(url, { cache: "no-store" })
        if (cancelled) return
        if (res.status === 401) return router.replace("/login")
        if (!res.ok) {
          setError((await res.json().catch(() => null))?.error ?? "Failed to load logs")
        } else {
          const text = await res.text()
          if (cancelled) return
          setError(null)
          setLogs(text)
        }
      } catch {
        if (!cancelled) setError("Failed to load logs")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    const timer = follow ? setInterval(load, 3_000) : undefined
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [environmentId, namespace, name, container, tail, follow, refreshKey, router])

  React.useEffect(() => {
    const el = preRef.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [logs, follow])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Logs</CardTitle>
        <CardDescription>Most recent lines, with timestamps</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-3">
          <Label className="font-normal">
            <Switch checked={follow} onCheckedChange={setFollow} />
            Auto-refresh
          </Label>
          {containers.length > 1 ? (
            <Select value={container} onValueChange={setContainer}>
              <SelectTrigger size="sm" className="w-44" aria-label="Container">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {containers.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Select value={tail} onValueChange={setTail}>
            <SelectTrigger size="sm" className="w-40" aria-label="Lines">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["100", "500", "1000", "5000"].map((n) => (
                <SelectItem key={n} value={n}>
                  Last {n} lines
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => {
              setLoading(true)
              setRefreshKey((k) => k + 1)
            }}
            disabled={loading}
            aria-label="Refresh logs"
          >
            <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <pre
            ref={preRef}
            data-testid="pod-logs"
            className="h-[28rem] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
          >
            {logs || "No log output."}
          </pre>
        )}
      </CardContent>
    </Card>
  )
}
