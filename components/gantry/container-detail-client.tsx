"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { PauseIcon, PlayIcon, RefreshCwIcon, RotateCwIcon, SquareIcon, Trash2Icon, ZapIcon } from "lucide-react"

import { containerAction, removeContainer } from "@/app/(app)/containers/actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { EditContainerDialog, PullRecreateButton, type RecreateInfo } from "@/components/gantry/container-edit-dialog"
import { LogDownloadDialog, LogOutput } from "@/components/gantry/log-tools"
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
import { useI18n } from "@/lib/i18n/client"
import type { ContainerAction } from "@/lib/server/docker/api"

export function ContainerActions({
  id,
  name,
  state,
  can,
  recreate,
}: {
  id: string
  name: string
  state: string
  can: { operate: boolean; manage: boolean }
  /** Edit / pull & recreate (managers only). */
  recreate?: RecreateInfo
}) {
  const router = useRouter()
  const { t, format } = useI18n()
  const environmentId = useEnvironmentId()
  const [pending, run] = useRunAction()
  const running = state === "running"
  const paused = state === "paused"
  const act = (action: ContainerAction) =>
    run(
      () => containerAction(id, action, environmentId),
      format(t.containers.actionDone, { name, action: t.containers.done[action] })
    )

  return (
    <div className="flex flex-wrap items-center gap-2">
      {can.operate ? <OperateButtons running={running} paused={paused} pending={pending} act={act} /> : null}
      {can.manage && recreate ? (
        <>
          <EditContainerDialog id={id} name={name} info={recreate} />
          <PullRecreateButton id={id} name={name} image={recreate.values.image} info={recreate} />
        </>
      ) : null}
      {can.manage ? (
        <ConfirmAction
          title={format(t.containers.removeTitle, { name })}
          description={t.containers.removeDescriptionForce}
          confirmLabel={t.common.actions.remove}
          onConfirm={async () => {
            const res = await removeContainer(id, { force: true }, environmentId)
            if (res.ok) router.push("/containers")
            return res
          }}
        >
          <Button size="sm" variant="destructive" disabled={pending}>
            <Trash2Icon data-icon="inline-start" />
            {t.common.actions.remove}
          </Button>
        </ConfirmAction>
      ) : null}
    </div>
  )
}

function OperateButtons({
  running,
  paused,
  pending,
  act,
}: {
  running: boolean
  paused: boolean
  pending: boolean
  act: (action: ContainerAction) => void
}) {
  const { t } = useI18n()
  return (
    <>
      {!running && !paused ? (
        <Button size="sm" disabled={pending} onClick={() => act("start")}>
          <PlayIcon data-icon="inline-start" />
          {t.common.actions.start}
        </Button>
      ) : null}
      {running ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act("stop")}>
          <SquareIcon data-icon="inline-start" />
          {t.common.actions.stop}
        </Button>
      ) : null}
      <Button size="sm" variant="outline" disabled={pending} onClick={() => act("restart")}>
        <RotateCwIcon data-icon="inline-start" />
        {t.common.actions.restart}
      </Button>
      {running ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act("pause")}>
          <PauseIcon data-icon="inline-start" />
          {t.containers.actions.pause}
        </Button>
      ) : null}
      {paused ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act("unpause")}>
          <PlayIcon data-icon="inline-start" />
          {t.containers.actions.resume}
        </Button>
      ) : null}
      {running ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act("kill")}>
          <ZapIcon data-icon="inline-start" />
          {t.containers.actions.kill}
        </Button>
      ) : null}
    </>
  )
}

export function LogViewer({ id }: { id: string }) {
  const router = useRouter()
  const { t, format } = useI18n()
  const text = t.containers.logs
  const [logs, setLogs] = React.useState<string>("")
  const [error, setError] = React.useState<string | null>(null)
  const [tail, setTail] = React.useState("500")
  const [follow, setFollow] = React.useState(true)
  const [loading, setLoading] = React.useState(false)
  const [refreshKey, setRefreshKey] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const res = await fetch(`/api/containers/${id}/logs?tail=${tail}`, { cache: "no-store" })
        if (cancelled) return
        if (res.status === 401) return router.replace("/login")
        if (!res.ok) {
          setError((await res.json()).error ?? text.loadFailed)
        } else {
          const text = await res.text()
          if (cancelled) return
          setError(null)
          setLogs(text)
        }
      } catch {
        if (!cancelled) setError(text.loadFailed)
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
  }, [id, tail, follow, refreshKey, router, text.loadFailed])

  return (
    <Card>
      <CardHeader>
        <CardTitle>{text.title}</CardTitle>
        <CardDescription>{text.description}</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-3">
          <Label className="font-normal">
            <Switch checked={follow} onCheckedChange={setFollow} />
            {text.autoRefresh}
          </Label>
          <Select value={tail} onValueChange={setTail}>
            <SelectTrigger size="sm" className="w-40" aria-label={text.lines}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["100", "500", "1000", "5000"].map((n) => (
                <SelectItem key={n} value={n}>
                  {format(text.lastLines, { count: n })}
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
            aria-label={text.refresh}
          >
            <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
          </Button>
          <LogDownloadDialog id={id} />
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <LogOutput logs={logs} follow={follow} />
        )}
      </CardContent>
    </Card>
  )
}
