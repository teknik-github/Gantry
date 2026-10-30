"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  CloudDownloadIcon,
  LayoutTemplateIcon,
  PlayIcon,
  PowerOffIcon,
  RocketIcon,
  RotateCwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react"

import { deleteStack, stackOperation } from "@/app/(app)/stacks/actions"
import { saveStackAsTemplate } from "@/app/(app)/templates/actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { useRunAction } from "@/components/gantry/use-action"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import type { StackOperation } from "@/lib/server/stacks/compose"

const PENDING_LABELS: Record<StackOperation, string> = {
  deploy: "Deploying…",
  redeploy: "Pulling & redeploying…",
  start: "Starting…",
  stop: "Stopping…",
  restart: "Restarting…",
  down: "Taking down…",
}

export function StackActions({
  id,
  name,
  running,
  total,
  canSaveTemplate,
}: {
  id: number
  name: string
  running: number
  total: number
  /** Templates are global: administrators only. */
  canSaveTemplate: boolean
}) {
  const router = useRouter()
  const environmentId = useEnvironmentId()
  const [pending, run] = useRunAction()
  const [current, setCurrent] = React.useState<StackOperation | null>(null)
  const [downVolumes, setDownVolumes] = React.useState(false)
  const [deleteVolumes, setDeleteVolumes] = React.useState(false)

  const act = (op: StackOperation) => {
    setCurrent(op)
    return run(() => stackOperation(id, op, {}, environmentId))
  }
  const busy = pending

  return (
    <div className="flex flex-wrap items-center gap-2">
      {busy && current ? <span className="text-sm text-muted-foreground">{PENDING_LABELS[current]}</span> : null}
      <Button size="sm" disabled={busy} onClick={() => act("deploy")}>
        <RocketIcon data-icon="inline-start" />
        Deploy
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => act("redeploy")}>
        <CloudDownloadIcon data-icon="inline-start" />
        Pull &amp; redeploy
      </Button>
      {total > 0 && running < total ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act("start")}>
          <PlayIcon data-icon="inline-start" />
          Start
        </Button>
      ) : null}
      {running > 0 ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act("stop")}>
          <SquareIcon data-icon="inline-start" />
          Stop
        </Button>
      ) : null}
      {total > 0 ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act("restart")}>
          <RotateCwIcon data-icon="inline-start" />
          Restart
        </Button>
      ) : null}
      {canSaveTemplate ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const res = await saveStackAsTemplate(id)
              if (res.href) router.push(res.href)
              return res
            })
          }
        >
          <LayoutTemplateIcon data-icon="inline-start" />
          Save as template
        </Button>
      ) : null}
      {total > 0 ? (
        <ConfirmAction
          title={`Take ${name} down?`}
          description="Stops and removes the stack's containers and networks (docker compose down). The stack stays in Gantry and can be deployed again."
          confirmLabel="Down"
          onConfirm={() => stackOperation(id, "down", { removeVolumes: downVolumes }, environmentId)}
          extra={
            <Label className="font-normal">
              <Checkbox checked={downVolumes} onCheckedChange={(v) => setDownVolumes(v === true)} />
              Also remove the stack&apos;s volumes (deletes their data)
            </Label>
          }
        >
          <Button size="sm" variant="outline" disabled={busy}>
            <PowerOffIcon data-icon="inline-start" />
            Down
          </Button>
        </ConfirmAction>
      ) : null}
      <ConfirmAction
        title={`Delete stack ${name}?`}
        description="Runs docker compose down, then removes the stack and its files from Gantry. This cannot be undone."
        confirmLabel="Delete"
        onConfirm={async () => {
          const res = await deleteStack(id, { removeVolumes: deleteVolumes }, environmentId)
          if (res.ok) router.push("/stacks")
          return res
        }}
        extra={
          <Label className="font-normal">
            <Checkbox checked={deleteVolumes} onCheckedChange={(v) => setDeleteVolumes(v === true)} />
            Also remove the stack&apos;s volumes (deletes their data)
          </Label>
        }
      >
        <Button size="sm" variant="destructive" disabled={busy}>
          <Trash2Icon data-icon="inline-start" />
          Delete
        </Button>
      </ConfirmAction>
    </div>
  )
}
