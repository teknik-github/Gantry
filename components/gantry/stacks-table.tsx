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

const STATUS_LABELS: Record<StackStatus, string> = {
  running: "running",
  partial: "partially running",
  stopped: "stopped",
  down: "not deployed",
  unknown: "unknown",
}

export function StackStatusBadge({ status, running, total }: { status: StackStatus; running: number; total: number }) {
  return (
    <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground">
      <span className={cn("size-2 rounded-full", STATUS_STYLES[status])} />
      {STATUS_LABELS[status]}
      {total > 0 ? <span className="tabular-nums">{`${running}/${total}`}</span> : null}
    </Badge>
  )
}

const stackHelper = columnHelperFor<StackRow>()

const stackColumns = stackHelper.columns([
  stackHelper.accessor("name", {
    header: ({ column }) => <SortHeader column={column} title="Name" />,
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
    header: ({ column }) => <SortHeader column={column} title="Status" />,
    cell: ({ row }) => (
      <StackStatusBadge status={row.original.status} running={row.original.running} total={row.original.total} />
    ),
  }),
  stackHelper.accessor((r) => r.services.join(", "), {
    id: "services",
    header: "Services",
    cell: ({ row }) =>
      row.original.services.length ? (
        <span className="block max-w-72 truncate text-sm">{row.original.services.join(", ")}</span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  }),
  stackHelper.accessor("lastRunLabel", {
    id: "last run",
    header: "Last run",
    cell: ({ row }) =>
      row.original.lastRunLabel ? (
        <span className={cn("text-sm", row.original.lastStatus === "error" ? "text-destructive" : "text-muted-foreground")}>
          {row.original.lastAction} {row.original.lastStatus === "error" ? "failed" : "ok"} · {row.original.lastRunLabel}
        </span>
      ) : (
        <span className="text-muted-foreground">never</span>
      ),
  }),
  stackHelper.accessor("createdBy", {
    id: "created by",
    header: "Created by",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdBy}</span>,
  }),
  stackHelper.accessor("updatedLabel", {
    id: "updated",
    header: "Updated",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.updatedLabel}</span>,
  }),
])

export function StacksTable({ data, canManage }: { data: StackRow[]; canManage: boolean }) {
  return (
    <DataTable
      data={data}
      columns={stackColumns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => `${r.name} ${r.services.join(" ")}`}
      searchPlaceholder="Search stacks…"
      emptyMessage="No stacks yet."
      pageSize={20}
      toolbar={
        canManage ? (
          <>
            <Button size="sm" variant="outline" asChild>
              <Link href="/templates">
                <LayoutTemplateIcon data-icon="inline-start" />
                <span className="hidden lg:inline">From template</span>
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/stacks/new">
                <PlusIcon data-icon="inline-start" />
                <span className="hidden lg:inline">Add stack</span>
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

function externalColumns(canImport: boolean) {
  return externalHelper.columns([
    externalHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Project" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{row.original.name}</span>
          <Badge variant="secondary">external</Badge>
        </div>
      ),
      enableHiding: false,
    }),
    externalHelper.accessor("status", {
      header: ({ column }) => <SortHeader column={column} title="Status" />,
      cell: ({ row }) => (
        <StackStatusBadge status={row.original.status} running={row.original.running} total={row.original.total} />
      ),
    }),
    externalHelper.accessor((r) => r.containers.length, {
      id: "containers",
      header: "Containers",
      enableSorting: false,
      cell: ({ row }) => <ContainerList containers={row.original.containers} />,
    }),
    externalHelper.accessor("configFiles", {
      id: "compose file",
      header: "Compose file",
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
              title={`Import ${row.original.name}?`}
              description={
                <>
                  Gantry copies the project&apos;s compose file (and its .env) into a new stack so you can manage it
                  here. Running containers are left alone. When you deploy it from Gantry, relative paths (bind
                  mounts, build contexts, env_file) resolve from Gantry&apos;s data directory instead of the original
                  project folder.
                </>
              }
              confirmLabel="Import"
              destructive={false}
              onConfirm={() => importProject(row.original.name)}
            >
              <Button variant="outline" size="sm">
                <ImportIcon data-icon="inline-start" />
                Import
              </Button>
            </ConfirmAction>
          </div>
        ) : null,
      enableHiding: false,
    }),
  ])
}

export function ExternalProjectsTable({ data, canImport }: { data: ExternalProjectRow[]; canImport: boolean }) {
  const columns = React.useMemo(() => externalColumns(canImport), [canImport])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.name}
      searchText={(r) => `${r.name} ${r.containers.map((c) => `${c.name} ${c.service}`).join(" ")}`}
      searchPlaceholder="Search projects…"
      emptyMessage="No other compose projects on this environment."
      pageSize={10}
    />
  )
}
