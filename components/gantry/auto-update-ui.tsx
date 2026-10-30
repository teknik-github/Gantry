"use client"

import * as React from "react"
import { useActionState } from "react"
import { PlayIcon, SaveIcon } from "lucide-react"
import { toast } from "sonner"

import { runAutoUpdateNow, saveSchedule, setContainerAutoUpdate } from "@/app/(app)/auto-update/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { Mono, StateBadge } from "@/components/gantry/ui"
import { submitKeepingValues, useRunAction } from "@/components/gantry/use-action"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { ActionState } from "@/lib/validation"

export function AutoUpdateSchedule({
  enabled,
  time,
  serverTime,
  timeZone,
  running,
}: {
  enabled: boolean
  time: string
  serverTime: string
  timeZone: string
  running: boolean
}) {
  const [state, formAction, saving] = useActionState<ActionState, FormData>(saveSchedule, {})
  React.useEffect(() => {
    if (state.ok) toast.success(state.message ?? "Saved")
    else if (state.error && !state.fieldErrors) toast.error(state.error)
  }, [state])
  const [runPending, run] = useRunAction()
  const uid = React.useId()

  return (
    <div className="px-4 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
          <CardDescription>
            Server time is {serverTime} ({timeZone}). Set <code>TZ</code> on the Gantry container to change the time zone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* No automatic form reset: Radix Select/Checkbox would jump back to their first values. */}
          <form method="post" onSubmit={submitKeepingValues(formAction)} className="flex flex-wrap items-end gap-4">
            <Label className="h-8 font-normal">
              <Checkbox name="enabled" value="on" defaultChecked={enabled} />
              Run every day
            </Label>
            <Field data-invalid={state.fieldErrors?.time ? true : undefined} className="w-32">
              <FieldLabel htmlFor={`${uid}-time`}>At</FieldLabel>
              <Input id={`${uid}-time`} name="time" type="time" defaultValue={time} required />
              <FieldError>{state.fieldErrors?.time?.[0]}</FieldError>
            </Field>
            <Button type="submit" variant="outline" disabled={saving}>
              <SaveIcon data-icon="inline-start" />
              {saving ? "Saving…" : "Save schedule"}
            </Button>
            <Button type="button" disabled={runPending || running} onClick={() => run(runAutoUpdateNow)}>
              <PlayIcon data-icon="inline-start" />
              {runPending || running ? "Updating…" : "Run now"}
            </Button>
          </form>
          <FieldDescription className="mt-3">
            Runs on every environment. Results are sent to the notification channels that subscribe to auto-update results.
          </FieldDescription>
        </CardContent>
      </Card>
    </div>
  )
}

export type AutoUpdateResultRow = {
  id: string
  environment: string
  container: string
  image: string
  status: "updated" | "current" | "skipped" | "failed"
  message: string
}

const STATUS_BADGE: Record<AutoUpdateResultRow["status"], string> = {
  updated: "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
  current: "text-muted-foreground",
  skipped: "text-muted-foreground",
  failed: "border-destructive/50 text-destructive",
}

const resultHelper = columnHelperFor<AutoUpdateResultRow>()
const resultColumns = resultHelper.columns([
  resultHelper.accessor("container", {
    header: ({ column }) => <SortHeader column={column} title="Container" />,
    cell: ({ row }) => <span className="font-medium">{row.original.container}</span>,
    enableHiding: false,
  }),
  resultHelper.accessor("status", {
    header: ({ column }) => <SortHeader column={column} title="Result" />,
    cell: ({ row }) => (
      <Badge variant="outline" className={STATUS_BADGE[row.original.status]}>
        {row.original.status === "current" ? "up to date" : row.original.status}
      </Badge>
    ),
  }),
  resultHelper.accessor("image", { header: "Image", cell: ({ row }) => <Mono>{row.original.image}</Mono> }),
  resultHelper.accessor("environment", { header: "Environment" }),
  resultHelper.accessor("message", {
    header: "Details",
    cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.message || "—"}</span>,
  }),
])

export function AutoUpdateResults({
  trigger,
  finishedLabel,
  results,
}: {
  trigger: string
  finishedLabel: string
  results: AutoUpdateResultRow[]
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="px-4 text-sm text-muted-foreground lg:px-6" data-testid="auto-update-last-run">
        Last run ({trigger === "manual" ? "started by hand" : "scheduled"}) finished {finishedLabel}
        {results.length ? "" : ": no running containers had auto-update on"}.
      </p>
      {results.length ? (
        <DataTable data={results} columns={resultColumns} getRowId={(r) => r.id} emptyMessage="Nothing to update." />
      ) : null}
    </div>
  )
}

export type AutoUpdateContainerRow = {
  id: string
  name: string
  image: string
  state: string
  enrolment: "rule" | "label" | null
  update: "update" | "current" | "unknown" | null
  stack: string | null
}

function EnrolSwitch({ row }: { row: AutoUpdateContainerRow }) {
  const environmentId = useEnvironmentId()
  const [pending, run] = useRunAction()
  if (row.enrolment === "label") {
    return (
      <Badge variant="secondary" title="Enabled by the gantry.auto-update=true label">
        label
      </Badge>
    )
  }
  return (
    <Switch
      checked={row.enrolment === "rule"}
      disabled={pending}
      aria-label={`Auto-update ${row.name}`}
      onCheckedChange={(on) => run(() => setContainerAutoUpdate(row.name, on, environmentId))}
    />
  )
}

const containerHelper = columnHelperFor<AutoUpdateContainerRow>()
const containerColumns = containerHelper.columns([
  containerHelper.accessor((r) => r.enrolment !== null, {
    id: "auto-update",
    header: ({ column }) => <SortHeader column={column} title="Auto-update" />,
    cell: ({ row }) => <EnrolSwitch row={row.original} />,
    enableHiding: false,
  }),
  containerHelper.accessor("name", {
    header: ({ column }) => <SortHeader column={column} title="Name" />,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    enableHiding: false,
  }),
  containerHelper.accessor("state", {
    header: "State",
    cell: ({ row }) => <StateBadge state={row.original.state} />,
  }),
  containerHelper.accessor("image", {
    header: "Image",
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <Mono className="max-w-72 truncate">{row.original.image}</Mono>
        {row.original.update === "update" ? (
          <Badge variant="outline" className="border-amber-500/50 px-1.5 text-amber-700 dark:text-amber-400">
            update
          </Badge>
        ) : null}
      </div>
    ),
  }),
  containerHelper.accessor("stack", {
    header: "Stack",
    cell: ({ row }) => row.original.stack ?? <span className="text-muted-foreground">—</span>,
  }),
])

export function AutoUpdateContainers({ data }: { data: AutoUpdateContainerRow[] }) {
  return (
    <DataTable
      data={data}
      columns={containerColumns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.image} ${r.stack ?? ""} ${r.enrolment ? "auto-update on" : ""}`}
      searchPlaceholder="Search containers…"
      emptyMessage="No containers."
      pageSize={20}
    />
  )
}
