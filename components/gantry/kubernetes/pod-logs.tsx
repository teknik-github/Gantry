"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { DownloadIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/lib/i18n/client"

/** The viewer keeps at most this much text; older lines scroll away. */
const MAX_CHARS = 1_000_000
/** Streamed chunks are rendered at most this often. */
const FLUSH_MS = 150

function trim(text: string) {
  if (text.length <= MAX_CHARS) return text
  const cut = text.indexOf("\n", text.length - MAX_CHARS)
  return text.slice(cut >= 0 ? cut + 1 : text.length - MAX_CHARS)
}

/**
 * Logs of one container of a pod. "Follow" streams new lines as they are
 * written (the request stays open; leaving the page or turning it off closes
 * it on the server too); otherwise the last lines are loaded once.
 */
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
  const { t, format } = useI18n()
  const k = t.kubernetes.logs
  const [container, setContainer] = React.useState(containers[0] ?? "")
  const [logs, setLogs] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [tail, setTail] = React.useState("500")
  const [follow, setFollow] = React.useState(true)
  const [previous, setPrevious] = React.useState(false)
  const [state, setState] = React.useState<"loading" | "streaming" | "ended" | "idle">("idle")
  const [refreshKey, setRefreshKey] = React.useState(0)
  const preRef = React.useRef<HTMLPreElement>(null)
  // The previous instance has finished: there is nothing to follow.
  const streaming = follow && !previous

  const query = React.useCallback(
    (extra: Record<string, string>) => {
      const q = new URLSearchParams({ tail, environment: String(environmentId), ...extra })
      if (container) q.set("container", container)
      if (previous) q.set("previous", "1")
      return `/api/kubernetes/pods/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/logs?${q}`
    },
    [tail, environmentId, container, previous, namespace, name]
  )

  React.useEffect(() => {
    const abort = new AbortController()
    let pending = ""
    let text = ""
    let flushTimer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      flushTimer = undefined
      if (!pending) return
      text = trim(text + pending)
      pending = ""
      setLogs(text)
    }

    async function load() {
      setState("loading")
      setError(null)
      setLogs("")
      try {
        const res = await fetch(query(streaming ? { follow: "1" } : {}), { cache: "no-store", signal: abort.signal })
        if (res.status === 401) return router.replace("/login")
        if (!res.ok) {
          setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? k.loadFailed)
          setState("idle")
          return
        }
        if (!streaming || !res.body) {
          setLogs(trim(await res.text()))
          setState("idle")
          return
        }
        setState("streaming")
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          pending += value
          flushTimer ??= setTimeout(flush, FLUSH_MS)
        }
        clearTimeout(flushTimer)
        flush()
        setState("ended")
      } catch {
        if (abort.signal.aborted) return
        clearTimeout(flushTimer)
        flush()
        setError(k.interrupted)
        setState("ended")
      }
    }

    void load()
    return () => {
      abort.abort()
      clearTimeout(flushTimer)
    }
  }, [query, streaming, refreshKey, router, k])

  React.useEffect(() => {
    const el = preRef.current
    if (el && streaming) el.scrollTop = el.scrollHeight
  }, [logs, streaming])

  return (
    <Card>
      <CardHeader>
        <CardTitle>{k.title}</CardTitle>
        <CardDescription>
          {state === "streaming"
            ? k.following
            : state === "ended" && streaming
              ? k.ended
              : k.recent}
        </CardDescription>
        <CardAction className="flex flex-wrap items-center gap-3">
          <Label className="font-normal">
            <Switch checked={follow} onCheckedChange={setFollow} disabled={previous} aria-label={k.follow} />
            {k.follow}
          </Label>
          <Label className="font-normal">
            <Switch checked={previous} onCheckedChange={setPrevious} aria-label={k.previousContainer} />
            {k.previous}
          </Label>
          {containers.length > 1 ? (
            <Select value={container} onValueChange={setContainer}>
              <SelectTrigger size="sm" className="w-44" aria-label={k.container}>
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
            <SelectTrigger size="sm" className="w-40" aria-label={k.lines}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["100", "500", "1000", "5000"].map((n) => (
                <SelectItem key={n} value={n}>
                  {format(k.lastLines, { count: n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="icon-sm"
            variant="outline"
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={state === "loading"}
            aria-label={k.reload}
          >
            <RefreshCwIcon className={state === "loading" ? "animate-spin" : undefined} />
          </Button>
          <Button size="icon-sm" variant="outline" asChild>
            <a href={query({ download: "1" })} download aria-label={k.download}>
              <DownloadIcon />
            </a>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <pre
          ref={preRef}
          data-testid="pod-logs"
          data-state={state}
          className="h-[28rem] overflow-auto overscroll-contain rounded-lg border max-sm:h-[60svh] bg-muted/40 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
        >
          {logs || (state === "loading" ? t.common.status.loading : k.empty)}
        </pre>
      </CardContent>
    </Card>
  )
}
