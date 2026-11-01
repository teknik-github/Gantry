"use client"

import * as React from "react"

import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import { cn } from "@/lib/utils"

export type ActivityRow = {
  id: number
  username: string
  action: string
  target: string
  at: string
  atLabel: string
}

const actHelper = columnHelperFor<ActivityRow>()

function activityColumns(t: I18n["t"]) {
  return actHelper.columns([
    actHelper.accessor("at", {
      header: ({ column }) => <SortHeader column={column} title={t.activity.columns.at} />,
      cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{row.original.atLabel}</span>,
    }),
    actHelper.accessor("username", {
      header: ({ column }) => <SortHeader column={column} title={t.activity.columns.username} />,
      cell: ({ row }) => <span className="font-medium">{row.original.username}</span>,
    }),
    actHelper.accessor("action", {
      header: ({ column }) => <SortHeader column={column} title={t.activity.columns.action} />,
      cell: ({ row }) => (
        <Badge variant="outline" className={cn(row.original.action.endsWith("failed") && "text-destructive")}>
          {row.original.action}
        </Badge>
      ),
    }),
    actHelper.accessor("target", {
      header: t.activity.columns.target,
      cell: ({ row }) => <Mono className="block max-w-96 truncate">{row.original.target}</Mono>,
    }),
  ])
}

export function ActivityTable({ data }: { data: ActivityRow[] }) {
  const { t } = useI18n()
  const columns = React.useMemo(() => activityColumns(t), [t])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => `${r.username} ${r.action} ${r.target}`}
      searchPlaceholder={t.activity.searchPlaceholder}
      emptyMessage={t.activity.empty}
      columnLabels={t.activity.columns}
      pageSize={50}
    />
  )
}
