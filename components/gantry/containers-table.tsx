"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowUpCircleIcon,
  CloudDownloadIcon,
  RefreshCwIcon,
  EllipsisVerticalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
  SquareIcon,
  Trash2Icon,
  ZapIcon,
  FileTextIcon,
  TerminalSquareIcon,
} from "lucide-react"

import {
  bulkContainerAction,
  containerAction,
  createContainer,
  removeContainer,
  removeContainers,
} from "@/app/(app)/containers/actions"
import { bulkPullAndRecreate, checkForUpdates } from "@/app/(app)/containers/recreate-actions"
import { columnHelperFor, DataTable, SortHeader, type TableSelection } from "@/components/data-table"
import { BulkButton, BulkConfirm } from "@/components/gantry/bulk"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { PullRecreateConfirm } from "@/components/gantry/container-edit-dialog"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono, StateBadge } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { useRunAction } from "@/components/gantry/use-action"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import type { ContainerUpdate } from "@/lib/image-updates"
import type { ContainerAction } from "@/lib/server/docker/api"

export type ContainerRow = {
  id: string
  name: string
  image: string
  state: string
  status: string
  created: number
  createdLabel: string
  ports: string[]
  stack: string | null
  /** Result of the last image update check; null when not checked. */
  update: ContainerUpdate | null
}

const helper = columnHelperFor<ContainerRow>()

function buildColumns(can: ContainerRights, t: I18n["t"]) {
  return helper.columns([
    helper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => (
        <Link
          href={`/containers/${row.original.id}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {row.original.name}
        </Link>
      ),
      enableHiding: false,
    }),
    helper.accessor("state", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.state} />,
      cell: ({ row }) => <StateBadge state={row.original.state} />,
    }),
    helper.accessor("image", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.image} />,
      cell: ({ row }) => (
        <div className="flex max-w-72 items-center gap-1.5">
          <Mono className="truncate">{row.original.image}</Mono>
          <UpdateBadge update={row.original.update} />
        </div>
      ),
    }),
    helper.accessor("stack", {
      header: t.common.fields.stack,
      cell: ({ row }) => row.original.stack ?? <span className="text-muted-foreground">—</span>,
    }),
    helper.accessor("ports", {
      header: t.common.fields.ports,
      enableSorting: false,
      cell: ({ row }) =>
        row.original.ports.length ? (
          <div className="flex max-w-56 flex-wrap gap-1">
            {row.original.ports.map((p) => (
              <Mono key={p} className="rounded bg-muted px-1.5 py-0.5">
                {p}
              </Mono>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    }),
    helper.accessor("created", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.created} />,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdLabel}</span>,
    }),
    helper.display({
      id: "actions",
      cell: ({ row }) => <RowActions row={row.original} can={can} />,
      enableHiding: false,
    }),
  ])
}

function UpdateBadge({ update }: { update: ContainerRow["update"] }) {
  const { t, format } = useI18n()
  if (update?.status === "update") {
    return (
      <Badge
        variant="outline"
        className="shrink-0 gap-1 border-amber-500/50 px-1.5 text-amber-700 dark:text-amber-400"
        title={format(t.containers.updateTitle, { reference: update.reference })}
        data-testid="update-badge"
      >
        <ArrowUpCircleIcon />
        {t.containers.updateBadge}
      </Badge>
    )
  }
  // Registry errors only; locally built images simply have nothing to compare.
  if (update?.status === "unknown" && update.reason && !update.reason.startsWith("Built or loaded locally")) {
    return (
      <Badge variant="outline" className="shrink-0 px-1.5 text-muted-foreground" title={update.reason}>
        {t.containers.unchecked}
      </Badge>
    )
  }
  return null
}

function CheckUpdatesButton({ lastChecked }: { lastChecked: number | null }) {
  const i18n = useI18n()
  const { t } = i18n
  const environmentId = useEnvironmentId()
  const [pending, run] = useRunAction()
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => run(() => checkForUpdates(environmentId))}
      title={lastChecked ? i18n.format(t.containers.lastChecked, { time: i18n.timeAgo(new Date(lastChecked)) }) : t.containers.notChecked}
    >
      <RefreshCwIcon data-icon="inline-start" className={pending ? "animate-spin" : undefined} />
      <span className="max-lg:sr-only">{pending ? t.containers.checking : t.containers.checkUpdates}</span>
    </Button>
  )
}

/** What the user may do with containers here (lib/permissions.ts); the server checks again. */
export type ContainerRights = { operate: boolean; manage: boolean }

export function ContainersTable({
  data,
  can,
  pageSize,
  lastUpdateCheck,
}: {
  data: ContainerRow[]
  can: ContainerRights
  pageSize?: number
  /** Shows the "Check updates" button (undefined hides it). */
  lastUpdateCheck?: number | null
}) {
  const { t } = useI18n()
  const rights = React.useMemo(() => ({ operate: can.operate, manage: can.manage }), [can.operate, can.manage])
  const columns = React.useMemo(() => buildColumns(rights, t), [rights, t])
  const selection: TableSelection<ContainerRow> | undefined = rights.operate
    ? {
        rowLabel: (r) => r.name,
        actions: (selected, clear) => <BulkActions selected={selected} clear={clear} canManage={rights.manage} />,
      }
    : undefined
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      selection={selection}
      searchText={(r) => `${r.name} ${r.image} ${r.state} ${r.stack ?? ""} ${r.update?.status === "update" ? t.containers.updateAvailable : ""}`}
      searchPlaceholder={t.containers.searchPlaceholder}
      emptyMessage={t.containers.empty}
      columnLabels={t.containers.columnMenu}
      pageSize={pageSize}
      toolbar={
        <>
          {lastUpdateCheck !== undefined && rights.operate ? <CheckUpdatesButton lastChecked={lastUpdateCheck} /> : null}
          {rights.manage ? <CreateContainerDialog /> : null}
        </>
      }
    />
  )
}

// Which selected containers each action applies to (Docker rejects the rest).
const APPLIES: Record<ContainerAction, (state: string) => boolean> = {
  start: (s) => s !== "running" && s !== "paused",
  stop: (s) => s === "running" || s === "paused" || s === "restarting",
  restart: () => true,
  pause: (s) => s === "running",
  unpause: (s) => s === "paused",
  kill: (s) => s === "running" || s === "paused" || s === "restarting",
}

const BULK_BUTTONS: { action: ContainerAction; label: (t: I18n["t"]) => string; icon: React.ReactNode }[] = [
  { action: "start", label: (t) => t.common.actions.start, icon: <PlayIcon data-icon="inline-start" /> },
  { action: "stop", label: (t) => t.common.actions.stop, icon: <SquareIcon data-icon="inline-start" /> },
  { action: "restart", label: (t) => t.common.actions.restart, icon: <RotateCwIcon data-icon="inline-start" /> },
  { action: "pause", label: (t) => t.containers.actions.pause, icon: <PauseIcon data-icon="inline-start" /> },
  { action: "unpause", label: (t) => t.containers.actions.resume, icon: <PlayIcon data-icon="inline-start" /> },
  { action: "kill", label: (t) => t.containers.actions.kill, icon: <ZapIcon data-icon="inline-start" /> },
]

const toTarget = (r: ContainerRow) => ({ id: r.id, name: r.name })

function BulkActions({ selected, clear, canManage }: { selected: ContainerRow[]; clear: () => void; canManage: boolean }) {
  const { t, format } = useI18n()
  const environmentId = useEnvironmentId()
  const [force, setForce] = React.useState(false)
  const [volumes, setVolumes] = React.useState(false)
  const running = selected.filter((r) => !APPLIES.start(r.state)).length

  return (
    <>
      {BULK_BUTTONS.map(({ action, label, icon }) => {
        const targets = selected.filter((r) => APPLIES[action](r.state))
        return (
          <BulkButton
            key={action}
            label={label(t)}
            icon={icon}
            count={targets.length}
            onRun={() => bulkContainerAction(targets.map(toTarget), action, environmentId)}
            onDone={clear}
          />
        )
      })}
      {canManage ? <BulkUpdate selected={selected} clear={clear} /> : null}
      {canManage ? (
        <BulkConfirm
          label={t.common.actions.remove}
          icon={<Trash2Icon data-icon="inline-start" />}
          title={format(t.containers.bulkRemoveTitle, { count: selected.length })}
          description={t.containers.bulkRemoveDescription}
          names={selected.map((r) => r.name)}
          warning={running && !force ? format(t.containers.bulkRemoveWarning, { count: running }) : null}
          onConfirm={() => removeContainers(selected.map(toTarget), { force, volumes }, environmentId)}
          onDone={clear}
          extra={
            <div className="flex flex-col gap-3">
              <Label className="font-normal">
                <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
                {t.containers.forceRunning}
              </Label>
              <Label className="font-normal">
                <Checkbox checked={volumes} onCheckedChange={(v) => setVolumes(v === true)} />
                {t.containers.removeVolumes}
              </Label>
            </div>
          }
        />
      ) : null}
    </>
  )
}

function BulkUpdate({ selected, clear }: { selected: ContainerRow[]; clear: () => void }) {
  const { t, format } = useI18n()
  const environmentId = useEnvironmentId()
  const targets = selected.filter((r) => r.update?.status === "update")
  const compose = targets.filter((r) => r.stack).length
  return (
    <BulkConfirm
      label={t.common.actions.update}
      icon={<ArrowUpCircleIcon data-icon="inline-start" />}
      title={format(t.containers.bulkUpdateTitle, { count: targets.length })}
      description={t.containers.bulkUpdateDescription}
      names={targets.map((r) => `${r.name} (${r.image})`)}
      warning={compose ? format(t.containers.bulkUpdateCompose, { count: compose }) : null}
      destructive={false}
      onConfirm={() => bulkPullAndRecreate(targets.map(toTarget), environmentId)}
      onDone={clear}
    />
  )
}

function RowActions({ row, can }: { row: ContainerRow; can: ContainerRights }) {
  const { t, format } = useI18n()
  const environmentId = useEnvironmentId()
  const [pending, run] = useRunAction()
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [confirmPull, setConfirmPull] = React.useState(false)
  const [force, setForce] = React.useState(false)
  const [volumes, setVolumes] = React.useState(false)

  const running = row.state === "running"
  const paused = row.state === "paused"
  const act = (action: ContainerAction) =>
    run(
      () => containerAction(row.id, action, environmentId),
      format(t.containers.actionDone, { name: row.name, action: t.containers.done[action] })
    )

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" disabled={pending}>
            <EllipsisVerticalIcon />
            <span className="sr-only">{t.common.actions.openMenu}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem asChild>
            <Link href={`/containers/${row.id}`}>
              <FileTextIcon />
              {can.operate ? t.containers.actions.detailsLogs : t.containers.actions.details}
            </Link>
          </DropdownMenuItem>
          {can.manage && running ? (
            <DropdownMenuItem asChild>
              <Link href={`/containers/${row.id}?tab=console`}>
                <TerminalSquareIcon />
                {t.containers.actions.console}
              </Link>
            </DropdownMenuItem>
          ) : null}
          {can.operate ? <DropdownMenuSeparator /> : null}
          {can.operate && !running && !paused ? (
            <DropdownMenuItem onSelect={() => act("start")}>
              <PlayIcon />
              {t.common.actions.start}
            </DropdownMenuItem>
          ) : null}
          {can.operate && running ? (
            <DropdownMenuItem onSelect={() => act("stop")}>
              <SquareIcon />
              {t.common.actions.stop}
            </DropdownMenuItem>
          ) : null}
          {can.operate ? (
            <DropdownMenuItem onSelect={() => act("restart")}>
              <RotateCwIcon />
              {t.common.actions.restart}
            </DropdownMenuItem>
          ) : null}
          {can.operate && running ? (
            <DropdownMenuItem onSelect={() => act("pause")}>
              <PauseIcon />
              {t.containers.actions.pause}
            </DropdownMenuItem>
          ) : null}
          {can.operate && paused ? (
            <DropdownMenuItem onSelect={() => act("unpause")}>
              <PlayIcon />
              {t.containers.actions.resume}
            </DropdownMenuItem>
          ) : null}
          {can.operate && running ? (
            <DropdownMenuItem onSelect={() => act("kill")}>
              <ZapIcon />
              {t.containers.actions.kill}
            </DropdownMenuItem>
          ) : null}
          {can.manage ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setConfirmPull(true)}>
                <CloudDownloadIcon />
                {t.containers.actions.pullRecreate}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmRemove(true)}>
                <Trash2Icon />
                {t.common.actions.remove}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {can.manage ? (
        <PullRecreateConfirm
          open={confirmPull}
          onOpenChange={setConfirmPull}
          id={row.id}
          name={row.name}
          image={row.image}
          composeProject={row.stack}
        />
      ) : null}
      <ConfirmAction
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={format(t.containers.removeTitle, { name: row.name })}
        description={t.containers.removeDescription}
        confirmLabel={t.common.actions.remove}
        onConfirm={() => removeContainer(row.id, { force, volumes }, environmentId)}
        extra={
          <div className="flex flex-col gap-3">
            <Label className="font-normal">
              <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
              {t.containers.forceOne}
            </Label>
            <Label className="font-normal">
              <Checkbox checked={volumes} onCheckedChange={(v) => setVolumes(v === true)} />
              {t.containers.removeVolumes}
            </Label>
          </div>
        }
      />
    </div>
  )
}

function CreateContainerDialog() {
  const { t } = useI18n()
  const text = t.containers.form
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon data-icon="inline-start" />
          <span className="max-lg:sr-only">{text.add}</span>
        </Button>
      }
      title={text.createTitle}
      description={text.createDescription}
      submitLabel={t.common.actions.create}
      action={createContainer}
      className="sm:max-w-lg"
    >
      {(errors) => (
        <FieldGroup className="max-h-[65vh] gap-4 overflow-y-auto pr-1">
          <Field data-invalid={errors.image ? true : undefined}>
            <FieldLabel htmlFor="c-image">{t.common.fields.image}</FieldLabel>
            <Input id="c-image" name="image" placeholder="nginx:latest" required />
            <FieldError>{errors.image?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.name ? true : undefined}>
            <FieldLabel htmlFor="c-name">{t.common.fields.name}</FieldLabel>
            <Input id="c-name" name="name" placeholder={text.namePlaceholder} />
            <FieldError>{errors.name?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.ports ? true : undefined}>
            <FieldLabel htmlFor="c-ports">{text.portMappings}</FieldLabel>
            <Textarea id="c-ports" name="ports" placeholder={"8080:80\n127.0.0.1:5432:5432/tcp"} rows={2} className="font-mono text-xs" />
            <FieldDescription>{text.portsHelp}</FieldDescription>
            <FieldError>{errors.ports?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.env ? true : undefined}>
            <FieldLabel htmlFor="c-env">{text.envVars}</FieldLabel>
            <Textarea id="c-env" name="env" placeholder={"TZ=Asia/Jakarta\nNODE_ENV=production"} rows={3} className="font-mono text-xs" />
            <FieldError>{errors.env?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.volumes ? true : undefined}>
            <FieldLabel htmlFor="c-volumes">{text.volumes}</FieldLabel>
            <Textarea id="c-volumes" name="volumes" placeholder={"app-data:/data\n/srv/config:/etc/app:ro"} rows={2} className="font-mono text-xs" />
            <FieldDescription>{text.volumesHelp}</FieldDescription>
            <FieldError>{errors.volumes?.[0]}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="c-command">{text.command}</FieldLabel>
            <Input id="c-command" name="command" placeholder={text.commandPlaceholder} className="font-mono text-xs" />
          </Field>
          <Field>
            <FieldLabel htmlFor="c-restart">{text.restartPolicy}</FieldLabel>
            <Select name="restart" defaultValue="unless-stopped">
              <SelectTrigger id="c-restart" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no">{text.restartPolicies.no}</SelectItem>
                <SelectItem value="always">{text.restartPolicies.always}</SelectItem>
                <SelectItem value="unless-stopped">{text.restartPolicies["unless-stopped"]}</SelectItem>
                <SelectItem value="on-failure">{text.restartPolicies["on-failure"]}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="flex flex-wrap gap-6">
            <Label className="font-normal">
              <Checkbox name="pull" value="on" defaultChecked />
              {text.pullFirst}
            </Label>
            <Label className="font-normal">
              <Checkbox name="start" value="on" defaultChecked />
              {text.startAfter}
            </Label>
          </div>
        </FieldGroup>
      )}
    </FormDialog>
  )
}
