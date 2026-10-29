"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PauseIcon, PlayIcon, RefreshCwIcon, RotateCwIcon, SquareIcon, Trash2Icon, ZapIcon } from "lucide-react"

import { containerAction, removeContainer } from "@/app/(app)/containers/actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { EditContainerDialog, PullRecreateButton, type RecreateInfo } from "@/components/gantry/container-edit-dialog"
import { useRunAction } from "@/components/gantry/use-action"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { ContainerAction } from "@/lib/server/docker/api"

export function ContainerActions({
  id,
  name,
  state,
  isAdmin,
  recreate,
}: {
  id: string
  name: string
  state: string
  isAdmin: boolean
  /** Edit / pull & recreate (administrators only). */
  recreate?: RecreateInfo
}) {
  const router = useRouter()
  const [pending, run] = useRunAction()
  const running = state === "running"
  const paused = state === "paused"
  const act = (action: ContainerAction, label: string) => run(() => containerAction(id, action), `${name}: ${label}`)

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!running && !paused ? (
        <Button size="sm" disabled={pending} onClick={() => act("start", "started")}>
          <PlayIcon data-icon="inline-start" />
          Start
        </Button>
      ) : null}
      {running ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act("stop", "stopped")}>
          <SquareIcon data-icon="inline-start" />
          Stop
        </Button>
      ) : null}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => act("restart", "restarted")}>
        <RotateCwIcon data-icon="inline-start" />
        Restart
      </Button>
      {running ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act("pause", "paused")}>
          <PauseIcon data-icon="inline-start" />
          Pause
        </Button>
      ) : null}
      {paused ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act("unpause", "resumed")}>
          <PlayIcon data-icon="inline-start" />
          Resume
        </Button>
      ) : null}
      {running ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act("kill", "killed")}>
          <ZapIcon data-icon="inline-start" />
          Kill
        </Button>
      ) : null}
      {isAdmin && recreate ? (
        <>
          <EditContainerDialog id={id} name={name} info={recreate} />
          <PullRecreateButton id={id} name={name} image={recreate.values.image} info={recreate} />
        </>
      ) : null}
      {isAdmin ? (
        <ConfirmAction
          title={`Remove ${name}?`}
          description="The container will be stopped and deleted. This cannot be undone."
          confirmLabel="Remove"
          onConfirm={async () => {
            const res = await removeContainer(id, { force: true })
            if (res.ok) router.push("/containers")
            return res
          }}
        >
          <Button size="sm" variant="destructive" disabled={pending}>
            <Trash2Icon data-icon="inline-start" />
            Remove
          </Button>
        </ConfirmAction>
      ) : null}
    </div>
  )
}

export function LogViewer({ id }: { id: string }) {
  const router = useRouter()
  const [logs, setLogs] = React.useState<string>("")
  const [error, setError] = React.useState<string | null>(null)
  const [tail, setTail] = React.useState("500")
  const [follow, setFollow] = React.useState(true)
  const [loading, setLoading] = React.useState(false)
  const [refreshKey, setRefreshKey] = React.useState(0)
  const preRef = React.useRef<HTMLPreElement>(null)

  React.useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch(`/api/containers/${id}/logs?tail=${tail}`, { cache: "no-store" })
        if (cancelled) return
        if (res.status === 401) return router.replace("/login")
        if (!res.ok) {
          setError((await res.json()).error ?? "Failed to load logs")
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
  }, [id, tail, follow, refreshKey, router])

  React.useEffect(() => {
    const el = preRef.current
    if (el && follow) el.scrollTop = el.scrollHeight
  }, [logs, follow])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Logs</CardTitle>
        <CardDescription>stdout and stderr, with timestamps</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-3">
          <Label className="font-normal">
            <Switch checked={follow} onCheckedChange={setFollow} />
            Auto-refresh
          </Label>
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
            className="h-[28rem] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
          >
            {logs || "No log output."}
          </pre>
        )}
      </CardContent>
    </Card>
  )
}
