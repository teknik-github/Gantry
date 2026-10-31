"use client"

import * as React from "react"
import { BellPlusIcon, PencilIcon, SendIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import {
  createChannel,
  deleteChannel,
  saveResourceThresholds,
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  ALERT_KIND_KEYS,
  CHANNEL_TYPE_KEYS,
  CHANNEL_TYPES,
  channelFields,
  type AlertKind,
  type ChannelType,
} from "@/lib/notifications"
import type { Thresholds } from "@/lib/thresholds"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import type { ActionState } from "@/lib/validation"

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

/** An alert kind's label in the user's language; unknown kinds (e.g. "test") as they are. */
const kindLabel = (t: I18n["t"], k: string) => (Object.hasOwn(t.notifications.kinds, k) ? t.notifications.kinds[k as AlertKind] : k)

/** A channel setting's label or description in the user's language (lib/notifications.ts has the English). */
function fieldText(texts: Partial<Record<string, string>>, name: string, fallback?: string) {
  return Object.hasOwn(texts, name) ? texts[name] : fallback
}

const channelHelper = columnHelperFor<ChannelRow>()

function channelColumns(t: I18n["t"]) {
  return channelHelper.columns([
    channelHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    channelHelper.accessor("typeLabel", {
      header: t.notifications.channels.columns.typeLabel,
      cell: ({ row }) => (
        <div className="flex flex-col">
          <span>{row.original.typeLabel}</span>
          <span className="text-xs text-muted-foreground">{row.original.target}</span>
        </div>
      ),
    }),
    channelHelper.accessor("events", {
      header: t.notifications.channels.columns.events,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex max-w-md flex-wrap gap-1">
          {row.original.events.length === ALERT_KIND_KEYS.length ? (
            <Badge variant="secondary">{t.notifications.channels.allAlerts}</Badge>
          ) : (
            row.original.events.map((e) => (
              <Badge key={e} variant="outline">
                {kindLabel(t, e)}
              </Badge>
            ))
          )}
        </div>
      ),
    }),
    channelHelper.accessor("enabled", {
      header: t.notifications.channels.columns.enabled,
      cell: ({ row }) => <EnabledSwitch row={row.original} />,
    }),
    channelHelper.display({
      id: "actions",
      cell: ({ row }) => <ChannelActions row={row.original} />,
      enableHiding: false,
    }),
  ])
}

export function ChannelsTable({ data }: { data: ChannelRow[] }) {
  const { t } = useI18n()
  const columns = React.useMemo(() => channelColumns(t), [t])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => String(r.id)}
      emptyMessage={t.notifications.channels.empty}
      columnLabels={t.notifications.channels.columns}
      toolbar={
        <FormDialog
          trigger={
            <Button size="sm">
              <BellPlusIcon data-icon="inline-start" />
              <span className="hidden lg:inline">{t.notifications.channels.add}</span>
            </Button>
          }
          title={t.notifications.channels.addTitle}
          submitLabel={t.common.actions.save}
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
  const { t, format } = useI18n()
  return (
    <Switch
      checked={row.enabled}
      disabled={pending}
      aria-label={format(t.notifications.channels.enabledLabel, { name: row.name })}
      onCheckedChange={(on) => run(() => setChannelEnabled(row.id, on))}
    />
  )
}

function ChannelActions({ row }: { row: ChannelRow }) {
  const [pending, run] = useRunAction()
  const { t, format } = useI18n()
  return (
    <div className="flex justify-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        aria-label={format(t.notifications.channels.testLabel, { name: row.name })}
        disabled={pending}
        onClick={() => run(() => testChannel(row.id))}
      >
        <SendIcon />
      </Button>
      <FormDialog
        trigger={
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={format(t.notifications.channels.editLabel, { name: row.name })}>
            <PencilIcon />
          </Button>
        }
        title={format(t.notifications.channels.editLabel, { name: row.name })}
        submitLabel={t.common.actions.save}
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
        title={format(t.notifications.channels.removeTitle, { name: row.name })}
        description={t.notifications.channels.removeDescription}
        confirmLabel={t.common.actions.remove}
        onConfirm={() => deleteChannel(row.id)}
      >
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={format(t.notifications.channels.removeLabel, { name: row.name })}>
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
  const { t } = useI18n()
  const typeLabels: Partial<Record<string, string>> = t.notifications.typeLabels

  return (
    <FieldGroup className="gap-4">
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-name`}>{t.common.fields.name}</FieldLabel>
        <Input id={`${uid}-name`} name="name" defaultValue={initial?.name} placeholder="Ops Telegram" required />
        <FieldError>{errors.name?.[0]}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${uid}-type`}>{t.common.fields.type}</FieldLabel>
        <Select name="type" value={type} onValueChange={(v) => setType(v as ChannelType)} disabled={Boolean(initial)}>
          <SelectTrigger id={`${uid}-type`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHANNEL_TYPE_KEYS.map((k) => (
              <SelectItem key={k} value={k}>
                {typeLabels[k] ?? CHANNEL_TYPES[k].label}
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
            <FieldLabel htmlFor={id}>{fieldText(t.notifications.fieldLabels, f.name, f.label)}</FieldLabel>
            {"options" in f && f.options ? (
              <OptionSelect id={id} name={`cfg:${f.name}`} options={f.options} initial={initial?.publicConfig[f.name]} />
            ) : (
              <Input
                id={id}
                name={`cfg:${f.name}`}
                type={secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                defaultValue={secret ? "" : initial?.publicConfig[f.name]}
                placeholder={secret && initial ? t.notifications.channels.keepSecret : "placeholder" in f ? f.placeholder : undefined}
              />
            )}
            {"description" in f && f.description ? (
              <FieldDescription>{fieldText(t.notifications.fieldDescriptions, f.name, f.description)}</FieldDescription>
            ) : null}
            <FieldError>{error}</FieldError>
          </Field>
        )
      })}
      <FieldSet data-invalid={errors.events ? true : undefined}>
        <FieldLegend variant="label">{t.notifications.channels.sendAlerts}</FieldLegend>
        <div className="grid gap-2">
          {ALERT_KIND_KEYS.map((k) => (
            <Label key={k} className="items-start font-normal">
              <Checkbox name="events" value={k} defaultChecked={events.has(k)} className="mt-0.5" />
              <span className="flex flex-col">
                {t.notifications.kinds[k]}
                <span className="text-xs text-muted-foreground">{t.notifications.kindDescriptions[k]}</span>
              </span>
            </Label>
          ))}
        </div>
        <FieldError>{errors.events?.[0]}</FieldError>
      </FieldSet>
      <Label className="font-normal">
        <Checkbox name="enabled" value="on" defaultChecked={initial?.enabled ?? true} />
        {t.common.status.enabled}
      </Label>
    </FieldGroup>
  )
}

function OptionSelect({ id, name, options, initial }: { id: string; name: string; options: readonly string[]; initial?: string }) {
  const [value, setValue] = React.useState(initial && options.includes(initial) ? initial : options[0])
  const { t } = useI18n()
  return (
    <Select name={name} value={value} onValueChange={setValue}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o === "starttls" ? "STARTTLS" : o === "tls" ? "TLS" : o === "none" ? t.common.status.none : o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ResourceThresholds({ thresholds }: { thresholds: Thresholds }) {
  const [state, formAction, pending] = React.useActionState<ActionState, FormData>(saveResourceThresholds, {})
  const { t } = useI18n()
  const saved = t.common.status.saved
  React.useEffect(() => {
    if (state.ok) toast.success(state.message ?? saved)
    else if (state.error && !state.fieldErrors) toast.error(state.error)
  }, [state, saved])
  const errs = state.fieldErrors ?? {}
  const values = state.values ?? {}
  const uid = React.useId()
  const field = (name: keyof Thresholds, label: string, unit: string, description?: string) => (
    <Field data-invalid={errs[name] ? true : undefined}>
      <FieldLabel htmlFor={`${uid}-${name}`}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          id={`${uid}-${name}`}
          name={name}
          type="number"
          min={1}
          defaultValue={values[name] ?? (thresholds[name] === null ? "" : String(thresholds[name]))}
          placeholder={t.notifications.thresholds.off}
          className="w-28"
        />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>{errs[name]?.[0]}</FieldError>
    </Field>
  )
  return (
    <div className="px-4 lg:px-6">
      <Card>
        <CardHeader>
          <CardTitle>{t.notifications.thresholds.title}</CardTitle>
          <CardDescription>{t.notifications.thresholds.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="flex flex-col gap-4">
            <div className="grid gap-4 @3xl/main:grid-cols-4">
              {field("containerCpu", t.notifications.thresholds.containerCpu, "%", t.notifications.thresholds.containerCpuHelp)}
              {field(
                "containerMemory",
                t.notifications.thresholds.containerMemory,
                t.notifications.thresholds.percentOfLimit,
                t.notifications.thresholds.containerMemoryHelp
              )}
              {field("hostMemory", t.notifications.thresholds.hostMemory, "%", t.notifications.thresholds.hostMemoryHelp)}
              {field("minutes", t.notifications.thresholds.minutes, t.notifications.thresholds.minutesUnit)}
            </div>
            <Button type="submit" variant="outline" className="w-fit" disabled={pending}>
              {pending ? t.common.status.saving : t.notifications.thresholds.save}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
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

function alertColumns(i18n: I18n) {
  const { t } = i18n
  return alertHelper.columns([
    alertHelper.accessor("time", {
      header: ({ column }) => <SortHeader column={column} title={t.notifications.alerts.columns.time} />,
      cell: ({ row }) => (
        <span
          className="whitespace-nowrap text-muted-foreground"
          // English keeps the browser's own date format.
          title={i18n.locale === "en" ? new Date(row.original.time).toLocaleString() : i18n.formatDate(row.original.time)}
        >
          {row.original.timeLabel}
        </span>
      ),
    }),
    alertHelper.accessor("kind", {
      header: t.notifications.alerts.columns.kind,
      cell: ({ row }) => <Badge variant="outline">{kindLabel(t, row.original.kind)}</Badge>,
    }),
    alertHelper.accessor("subject", {
      header: t.notifications.alerts.subject,
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
    alertHelper.accessor("environment", { header: t.notifications.alerts.columns.environment }),
    alertHelper.accessor("delivery", {
      header: t.notifications.alerts.columns.delivery,
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.delivery}</span>,
    }),
  ])
}

export function AlertsTable({ data }: { data: AlertRow[] }) {
  const i18n = useI18n()
  const { t } = i18n
  const columns = React.useMemo(() => alertColumns(i18n), [i18n])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => `${r.subject} ${r.message} ${r.environment} ${kindLabel(t, r.kind)}`}
      searchPlaceholder={t.notifications.alerts.searchPlaceholder}
      emptyMessage={t.notifications.alerts.empty}
      columnLabels={t.notifications.alerts.columns}
    />
  )
}
