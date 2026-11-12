"use client"

import * as React from "react"
import Link from "next/link"
import {
  CloudDownloadIcon,
  EllipsisVerticalIcon,
  ImportIcon,
  LayoutTemplateIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react"

import { externalProjectOperation, importProject } from "@/app/(app)/stacks/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { useRunAction } from "@/components/gantry/use-action"
import { Mono, StateBadge } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import type { StackStatus } from "@/lib/stacks"
import { cn } from "@/lib/utils"

export type StackContainer = { id: string; name: string; service: string; state: string }

export type StackRow = {
  id: number
  name: string
  status: StackStatus
  running: number
  total: number
  services: string[]
  createdBy: string
  updatedLabel: string
  lastStatus: "success" | "error" | null
  lastAction: string | null
  lastRunLabel: string | null
  /** Sourced from a Git repository. */
  git: boolean
}

export type ExternalProjectRow = {
  name: string
  status: StackStatus
  running: number
  total: number
  containers: StackContainer[]
  configFiles: string | null
  importable: boolean
}

const STATUS_STYLES: Record<StackStatus, string> = {
  running: "bg-emerald-500",
  partial: "bg-amber-500",
  stopped: "bg-red-500",
  down: "bg-muted-foreground",
  unknown: "bg-muted-foreground/40",
}

export function StackStatusBadge({ status, running, total }: { status: StackStatus; running: number; total: number }) {
  const { t } = useI18n()
  return (
    <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground">
      <span className={cn("size-2 rounded-full", STATUS_STYLES[status])} />
      {t.stacks.status[status]}
      {total > 0 ? <span className="tabular-nums">{`${running}/${total}`}</span> : null}
    </Badge>
  )
}

const stackHelper = columnHelperFor<StackRow>()

function stackColumns(t: I18n["t"]) {
  return stackHelper.columns([
    stackHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <Link href={`/stacks/${row.original.id}`} className="font-medium underline-offset-4 hover:underline">
            {row.original.name}
          </Link>
          {row.original.git ? (
            <Badge variant="outline" className="px-1.5 text-muted-foreground">
              Git
            </Badge>
          ) : null}
        </span>
      ),
      enableHiding: false,
    }),
    stackHelper.accessor("status", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.status} />,
      cell: ({ row }) => (
        <StackStatusBadge status={row.original.status} running={row.original.running} total={row.original.total} />
      ),
    }),
    stackHelper.accessor((r) => r.services.join(", "), {
      id: "services",
      header: t.stacks.list.services,
      cell: ({ row }) =>
        row.original.services.length ? (
          <span className="block max-w-72 truncate text-sm">{row.original.services.join(", ")}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    }),
    stackHelper.accessor("lastRunLabel", {
      id: "last run",
      header: t.stacks.list.lastRun,
      cell: ({ row }) =>
        row.original.lastRunLabel ? (
          <span className={cn("text-sm", row.original.lastStatus === "error" ? "text-destructive" : "text-muted-foreground")}>
            {row.original.lastAction} {row.original.lastStatus === "error" ? t.stacks.list.lastRunFailed : t.stacks.list.lastRunOk} · {row.original.lastRunLabel}
          </span>
        ) : (
          <span className="text-muted-foreground">{t.common.status.never}</span>
        ),
    }),
    stackHelper.accessor("createdBy", {
      id: "created by",
      header: t.stacks.list.createdBy,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdBy}</span>,
    }),
    stackHelper.accessor("updatedLabel", {
      id: "updated",
      header: t.common.fields.updated,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.updatedLabel}</span>,
    }),
  ])
}

export function StacksTable({ data, canManage }: { data: StackRow[]; canManage: boolean }) {
  const { t } = useI18n()
  const columns = React.useMemo(() => stackColumns(t), [t])
  const labels = t.stacks.list.columns
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => `${r.name} ${r.services.join(" ")}`}
      searchPlaceholder={t.stacks.list.searchPlaceholder}
      emptyMessage={t.stacks.list.empty}
      pageSize={20}
      columnLabels={{
        status: labels.status,
        services: labels.services,
        "last run": labels.lastRun,
        "created by": labels.createdBy,
        updated: labels.updated,
      }}
      toolbar={
        canManage ? (
          <>
            <Button size="sm" variant="outline" asChild>
              <Link href="/templates">
                <LayoutTemplateIcon data-icon="inline-start" />
                <span className="max-lg:sr-only">{t.stacks.list.fromTemplate}</span>
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/stacks/new">
                <PlusIcon data-icon="inline-start" />
                <span className="max-lg:sr-only">{t.stacks.list.addStack}</span>
              </Link>
            </Button>
          </>
        ) : null
      }
    />
  )
}

export function ContainerList({ containers }: { containers: StackContainer[] }) {
  if (containers.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-col gap-1">
      {containers.map((c) => (
        <div key={c.id} className="flex flex-wrap items-center gap-2">
          <StateBadge state={c.state} />
          <Link href={`/containers/${c.id}`} className="text-sm underline-offset-4 hover:underline">
            {c.name}
          </Link>
          <span className="text-xs text-muted-foreground">{c.service}</span>
        </div>
      ))}
    </div>
  )
}

const externalHelper = columnHelperFor<ExternalProjectRow>()

/** Environment rights for external projects: operate starts/stops, manage redeploys/removes. */
export type ProjectRights = { operate: boolean; manage: boolean }

function externalColumns(canImport: boolean, can: ProjectRights, i18n: I18n) {
  const { t } = i18n
  return externalHelper.columns([
    externalHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.stacks.list.project} />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.original.name}</span>
          <Badge variant="secondary">{t.stacks.list.external}</Badge>
        </div>
      ),
      enableHiding: false,
    }),
    externalHelper.accessor("status", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.status} />,
      cell: ({ row }) => (
        <StackStatusBadge status={row.original.status} running={row.original.running} total={row.original.total} />
      ),
    }),
    externalHelper.accessor((r) => r.containers.length, {
      id: "containers",
      header: t.stacks.list.containers,
      enableSorting: false,
      cell: ({ row }) => <ContainerList containers={row.original.containers} />,
    }),
    externalHelper.accessor("configFiles", {
      id: "compose file",
      header: t.stacks.list.composeFile,
      cell: ({ row }) =>
        row.original.configFiles ? (
          <Mono className="block max-w-72 truncate text-muted-foreground">{row.original.configFiles}</Mono>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    }),
    externalHelper.display({
      id: "actions",
      cell: ({ row }) => <ExternalRowActions row={row.original} canImport={canImport} can={can} />,
      enableHiding: false,
    }),
  ])
}

function ExternalRowActions({ row, canImport, can }: { row: ExternalProjectRow; canImport: boolean; can: ProjectRights }) {
  const { t, format } = useI18n()
  const text = t.stacks.list
  const environmentId = useEnvironmentId()
  const [pending, run] = useRunAction()
  const [confirmImport, setConfirmImport] = React.useState(false)
  const [confirmRedeploy, setConfirmRedeploy] = React.useState(false)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [volumes, setVolumes] = React.useState(false)

  const importable = canImport && row.importable
  if (!importable && !can.operate) return null
  const act = (op: "start" | "stop" | "restart") => run(() => externalProjectOperation(row.name, op, {}, environmentId))

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" disabled={pending}>
            <EllipsisVerticalIcon />
            <span className="sr-only">{t.common.actions.openMenu}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {can.operate && row.running < row.total ? (
            <DropdownMenuItem onSelect={() => act("start")}>
              <PlayIcon />
              {t.common.actions.start}
            </DropdownMenuItem>
          ) : null}
          {can.operate && row.running > 0 ? (
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
          {can.manage ? (
            <DropdownMenuItem onSelect={() => setConfirmRedeploy(true)}>
              <CloudDownloadIcon />
              {t.stacks.actions.pullRedeploy}
            </DropdownMenuItem>
          ) : null}
          {importable ? (
            <>
              {can.operate ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem onSelect={() => setConfirmImport(true)}>
                <ImportIcon />
                {text.import}
              </DropdownMenuItem>
            </>
          ) : null}
          {can.manage ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmRemove(true)}>
                <Trash2Icon />
                {t.common.actions.remove}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {importable ? (
        <ConfirmAction
          open={confirmImport}
          onOpenChange={setConfirmImport}
          title={format(text.importTitle, { name: row.name })}
          description={text.importDescription}
          confirmLabel={text.import}
          destructive={false}
          onConfirm={() => importProject(row.name)}
        />
      ) : null}
      {can.manage ? (
        <>
          <ConfirmAction
            open={confirmRedeploy}
            onOpenChange={setConfirmRedeploy}
            title={format(text.redeployTitle, { name: row.name })}
            description={text.redeployDescription}
            confirmLabel={t.stacks.actions.pullRedeploy}
            destructive={false}
            onConfirm={() => externalProjectOperation(row.name, "redeploy", {}, environmentId)}
          />
          <ConfirmAction
            open={confirmRemove}
            onOpenChange={setConfirmRemove}
            title={format(text.removeTitle, { name: row.name })}
            description={text.removeDescription}
            confirmLabel={t.common.actions.remove}
            onConfirm={() => externalProjectOperation(row.name, "remove", { removeVolumes: volumes }, environmentId)}
            extra={
              <Label className="font-normal">
                <Checkbox checked={volumes} onCheckedChange={(v) => setVolumes(v === true)} />
                {text.removeVolumes}
              </Label>
            }
          />
        </>
      ) : null}
    </div>
  )
}

export function ExternalProjectsTable({
  data,
  canImport,
  can,
}: {
  data: ExternalProjectRow[]
  canImport: boolean
  can: ProjectRights
}) {
  const i18n = useI18n()
  const { t } = i18n
  const rights = React.useMemo(() => ({ operate: can.operate, manage: can.manage }), [can.operate, can.manage])
  const columns = React.useMemo(() => externalColumns(canImport, rights, i18n), [canImport, rights, i18n])
  const labels = t.stacks.list.columns
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.name}
      searchText={(r) => `${r.name} ${r.containers.map((c) => `${c.name} ${c.service}`).join(" ")}`}
      searchPlaceholder={t.stacks.list.searchProjects}
      emptyMessage={t.stacks.list.noProjects}
      pageSize={10}
      columnLabels={{ status: labels.status, containers: labels.containers, "compose file": labels.composeFile }}
    />
  )
}
