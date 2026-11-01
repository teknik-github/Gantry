"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  CloudDownloadIcon,
  GitPullRequestArrowIcon,
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
import { useI18n } from "@/lib/i18n/client"
import type { StackOperation } from "@/lib/server/stacks/compose"

export function StackActions({
  id,
  name,
  running,
  total,
  git = false,
  canSaveTemplate,
}: {
  id: number
  name: string
  running: number
  total: number
  /** Git stacks: "Pull & redeploy" fetches the repository; offer a forced redeploy too. */
  git?: boolean
  /** Templates are global: administrators only. */
  canSaveTemplate: boolean
}) {
  const i18n = useI18n()
  const { t } = i18n
  const text = t.stacks.actions
  const router = useRouter()
  const environmentId = useEnvironmentId()
  const [pending, run] = useRunAction()
  const [current, setCurrent] = React.useState<StackOperation | "force" | null>(null)
  const [downVolumes, setDownVolumes] = React.useState(false)
  const [deleteVolumes, setDeleteVolumes] = React.useState(false)

  const act = (op: StackOperation) => {
    setCurrent(op)
    return run(() => stackOperation(id, op, {}, environmentId))
  }
  const forceRedeploy = () => {
    setCurrent("force")
    return run(() => stackOperation(id, "redeploy", { force: true }, environmentId))
  }
  const busy = pending

  return (
    <div className="flex flex-wrap items-center gap-2">
      {busy && current ? (
        <span className="text-sm text-muted-foreground">
          {current === "force" ? text.pending.redeploy : text.pending[current]}
        </span>
      ) : null}
      <Button size="sm" disabled={busy} onClick={() => act("deploy")}>
        <RocketIcon data-icon="inline-start" />
        {t.common.actions.deploy}
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => act("redeploy")}>
        <CloudDownloadIcon data-icon="inline-start" />
        {text.pullRedeploy}
      </Button>
      {git ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={forceRedeploy}
          title={text.forceRedeployTitle}
        >
          <GitPullRequestArrowIcon data-icon="inline-start" />
          {text.forceRedeploy}
        </Button>
      ) : null}
      {total > 0 && running < total ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act("start")}>
          <PlayIcon data-icon="inline-start" />
          {t.common.actions.start}
        </Button>
      ) : null}
      {running > 0 ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act("stop")}>
          <SquareIcon data-icon="inline-start" />
          {t.common.actions.stop}
        </Button>
      ) : null}
      {total > 0 ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act("restart")}>
          <RotateCwIcon data-icon="inline-start" />
          {t.common.actions.restart}
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
          {text.saveAsTemplate}
        </Button>
      ) : null}
      {total > 0 ? (
        <ConfirmAction
          title={i18n.format(text.downTitle, { name })}
          description={text.downDescription}
          confirmLabel={text.down}
          onConfirm={() => stackOperation(id, "down", { removeVolumes: downVolumes }, environmentId)}
          extra={
            <Label className="font-normal">
              <Checkbox checked={downVolumes} onCheckedChange={(v) => setDownVolumes(v === true)} />
              {text.removeVolumes}
            </Label>
          }
        >
          <Button size="sm" variant="outline" disabled={busy}>
            <PowerOffIcon data-icon="inline-start" />
            {text.down}
          </Button>
        </ConfirmAction>
      ) : null}
      <ConfirmAction
        title={i18n.format(text.deleteTitle, { name })}
        description={text.deleteDescription}
        confirmLabel={t.common.actions.delete}
        onConfirm={async () => {
          const res = await deleteStack(id, { removeVolumes: deleteVolumes }, environmentId)
          if (res.ok) router.push("/stacks")
          return res
        }}
        extra={
          <Label className="font-normal">
            <Checkbox checked={deleteVolumes} onCheckedChange={(v) => setDeleteVolumes(v === true)} />
            {text.removeVolumes}
          </Label>
        }
      >
        <Button size="sm" variant="destructive" disabled={busy}>
          <Trash2Icon data-icon="inline-start" />
          {t.common.actions.delete}
        </Button>
      </ConfirmAction>
    </div>
  )
}
