"use client"

import * as React from "react"
import Link from "next/link"
import { ImportIcon, LayoutTemplateIcon, PlusIcon } from "lucide-react"

import { importProject } from "@/app/(app)/stacks/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { Mono, StateBadge } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
                <span className="hidden lg:inline">{t.stacks.list.fromTemplate}</span>
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/stacks/new">
                <PlusIcon data-icon="inline-start" />
                <span className="hidden lg:inline">{t.stacks.list.addStack}</span>
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

function externalColumns(canImport: boolean, i18n: I18n) {
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
      cell: ({ row }) =>
        canImport && row.original.importable ? (
          <div className="flex justify-end">
            <ConfirmAction
              title={i18n.format(t.stacks.list.importTitle, { name: row.original.name })}
              description={t.stacks.list.importDescription}
              confirmLabel={t.stacks.list.import}
              destructive={false}
              onConfirm={() => importProject(row.original.name)}
            >
              <Button variant="outline" size="sm">
                <ImportIcon data-icon="inline-start" />
                {t.stacks.list.import}
              </Button>
            </ConfirmAction>
          </div>
        ) : null,
      enableHiding: false,
    }),
  ])
}

export function ExternalProjectsTable({ data, canImport }: { data: ExternalProjectRow[]; canImport: boolean }) {
  const i18n = useI18n()
  const { t } = i18n
  const columns = React.useMemo(() => externalColumns(canImport, i18n), [canImport, i18n])
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
