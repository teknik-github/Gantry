"use client"

import * as React from "react"
import { BellPlusIcon, PencilIcon, SendIcon, Trash2Icon } from "lucide-react"

import {
  createChannel,
  deleteChannel,
  setChannelEnabled,
  testChannel,
  updateChannel,
} from "@/app/(app)/notifications/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { FormDialog } from "@/components/gantry/form-dialog"
import { useRunAction } from "@/components/gantry/use-action"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  ALERT_KIND_KEYS,
  ALERT_KINDS,
  CHANNEL_TYPE_KEYS,
  CHANNEL_TYPES,
  channelFields,
  type AlertKind,
  type ChannelType,
} from "@/lib/notifications"

type Errors = Record<string, string[] | undefined>

export type ChannelRow = {
  id: number
  name: string
  type: ChannelType
  typeLabel: string
  target: string
  events: AlertKind[]
  enabled: boolean
  publicConfig: Record<string, string>
}

const kindLabel = (k: string) => (ALERT_KINDS as Record<string, { label: string }>)[k]?.label ?? k

const channelHelper = columnHelperFor<ChannelRow>()

const channelColumns = channelHelper.columns([
  channelHelper.accessor("name", {
    header: ({ column }) => <SortHeader column={column} title="Name" />,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    enableHiding: false,
  }),
  channelHelper.accessor("typeLabel", {
    header: "Type",
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span>{row.original.typeLabel}</span>
        <span className="text-xs text-muted-foreground">{row.original.target}</span>
      </div>
    ),
  }),
  channelHelper.accessor("events", {
    header: "Alerts",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex max-w-md flex-wrap gap-1">
        {row.original.events.length === ALERT_KIND_KEYS.length ? (
          <Badge variant="secondary">All alerts</Badge>
        ) : (
          row.original.events.map((e) => (
            <Badge key={e} variant="outline">
              {kindLabel(e)}
            </Badge>
          ))
        )}
      </div>
    ),
  }),
  channelHelper.accessor("enabled", {
    header: "On",
    cell: ({ row }) => <EnabledSwitch row={row.original} />,
  }),
  channelHelper.display({
    id: "actions",
    cell: ({ row }) => <ChannelActions row={row.original} />,
    enableHiding: false,
  }),
])

export function ChannelsTable({ data }: { data: ChannelRow[] }) {
  return (
    <DataTable
      data={data}
      columns={channelColumns}
      getRowId={(r) => String(r.id)}
      emptyMessage="No channels yet. Alerts are still recorded below."
      toolbar={
        <FormDialog
          trigger={
            <Button size="sm">
              <BellPlusIcon data-icon="inline-start" />
              <span className="hidden lg:inline">Add channel</span>
            </Button>
          }
          title="Add notification channel"
          submitLabel="Save"
          action={createChannel}
          className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        >
          {(errors) => <ChannelFields errors={errors} />}
        </FormDialog>
      }
    />
  )
}

function EnabledSwitch({ row }: { row: ChannelRow }) {
  const [pending, run] = useRunAction()
  return (
    <Switch
      checked={row.enabled}
      disabled={pending}
      aria-label={`${row.name} enabled`}
      onCheckedChange={(on) => run(() => setChannelEnabled(row.id, on))}
    />
  )
}

function ChannelActions({ row }: { row: ChannelRow }) {
  const [pending, run] = useRunAction()
  return (
    <div className="flex justify-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        aria-label={`Send a test to ${row.name}`}
        disabled={pending}
        onClick={() => run(() => testChannel(row.id))}
      >
        <SendIcon />
      </Button>
      <FormDialog
        trigger={
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Edit ${row.name}`}>
            <PencilIcon />
          </Button>
        }
        title={`Edit ${row.name}`}
        submitLabel="Save"
        action={updateChannel}
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
      >
        {(errors) => (
          <>
            <input type="hidden" name="id" value={row.id} />
            <ChannelFields errors={errors} initial={row} />
          </>
        )}
      </FormDialog>
      <ConfirmAction
        title={`Remove ${row.name}?`}
        description="Alerts will no longer be sent to it."
        confirmLabel="Remove"
        onConfirm={() => deleteChannel(row.id)}
      >
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Remove ${row.name}`}>
          <Trash2Icon />
        </Button>
      </ConfirmAction>
    </div>
  )
}

function ChannelFields({ errors, initial }: { errors: Errors; initial?: ChannelRow }) {
  const [type, setType] = React.useState<ChannelType>(initial?.type ?? "telegram")
  const uid = React.useId()
  const events = new Set<AlertKind>(initial?.events ?? ALERT_KIND_KEYS)

  return (
    <FieldGroup className="gap-4">
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-name`}>Name</FieldLabel>
        <Input id={`${uid}-name`} name="name" defaultValue={initial?.name} placeholder="Ops Telegram" required />
        <FieldError>{errors.name?.[0]}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-type`}>Type</FieldLabel>
        <Select name="type" value={type} onValueChange={(v) => setType(v as ChannelType)} disabled={Boolean(initial)}>
          <SelectTrigger id={`${uid}-type`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHANNEL_TYPE_KEYS.map((t) => (
              <SelectItem key={t} value={t}>
                {CHANNEL_TYPES[t].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* A disabled select isn't submitted. */}
        {initial ? <input type="hidden" name="type" value={type} /> : null}
      </Field>
      {channelFields(type).map((f) => {
        const secret = "secret" in f && f.secret
        const id = `${uid}-cfg-${f.name}`
        const error = errors[`cfg:${f.name}`]?.[0]
        return (
          <Field key={`${type}-${f.name}`} data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={id}>{f.label}</FieldLabel>
            <Input
              id={id}
              name={`cfg:${f.name}`}
              type={secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              defaultValue={secret ? "" : initial?.publicConfig[f.name]}
              placeholder={secret && initial ? "Leave empty to keep the current one" : "placeholder" in f ? f.placeholder : undefined}
            />
            {"description" in f && f.description ? <FieldDescription>{f.description}</FieldDescription> : null}
            <FieldError>{error}</FieldError>
          </Field>
        )
      })}
      <FieldSet data-invalid={errors.events ? true : undefined}>
        <FieldLegend variant="label">Send these alerts</FieldLegend>
        <div className="grid gap-2">
          {ALERT_KIND_KEYS.map((k) => (
            <Label key={k} className="items-start font-normal">
              <Checkbox name="events" value={k} defaultChecked={events.has(k)} className="mt-0.5" />
              <span className="flex flex-col">
                {ALERT_KINDS[k].label}
                <span className="text-xs text-muted-foreground">{ALERT_KINDS[k].description}</span>
              </span>
            </Label>
          ))}
        </div>
        <FieldError>{errors.events?.[0]}</FieldError>
      </FieldSet>
      <Label className="font-normal">
        <Checkbox name="enabled" value="on" defaultChecked={initial?.enabled ?? true} />
        Enabled
      </Label>
    </FieldGroup>
  )
}

export type AlertRow = {
  id: number
  time: string
  timeLabel: string
  environment: string
  kind: string
  subject: string
  message: string
  delivery: string
}

const alertHelper = columnHelperFor<AlertRow>()

const alertColumns = alertHelper.columns([
  alertHelper.accessor("time", {
    header: ({ column }) => <SortHeader column={column} title="When" />,
    cell: ({ row }) => (
      <span className="whitespace-nowrap text-muted-foreground" title={new Date(row.original.time).toLocaleString()}>
        {row.original.timeLabel}
      </span>
    ),
  }),
  alertHelper.accessor("kind", {
    header: "Alert",
    cell: ({ row }) => <Badge variant="outline">{kindLabel(row.original.kind)}</Badge>,
  }),
  alertHelper.accessor("subject", {
    header: "What happened",
    enableHiding: false,
    cell: ({ row }) => (
      <div className="flex max-w-xl flex-col">
        <span className="font-medium">{row.original.subject}</span>
        {row.original.message ? (
          <span className="line-clamp-2 text-xs whitespace-pre-line text-muted-foreground" title={row.original.message}>
            {row.original.message}
          </span>
        ) : null}
      </div>
    ),
  }),
  alertHelper.accessor("environment", { header: "Environment" }),
  alertHelper.accessor("delivery", {
    header: "Delivery",
    cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.delivery}</span>,
  }),
])

export function AlertsTable({ data }: { data: AlertRow[] }) {
  return (
    <DataTable
      data={data}
      columns={alertColumns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => `${r.subject} ${r.message} ${r.environment} ${kindLabel(r.kind)}`}
      searchPlaceholder="Search alerts…"
      emptyMessage="No alerts yet."
    />
  )
}
