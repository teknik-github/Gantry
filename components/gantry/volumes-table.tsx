"use client"

import * as React from "react"
import Link from "next/link"
import { FolderOpenIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { createVolume, removeVolume, removeVolumes } from "@/app/(app)/volumes/actions"
import { columnHelperFor, DataTable, SortHeader, type TableSelection } from "@/components/data-table"
import { BulkConfirm } from "@/components/gantry/bulk"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"

export type VolumeRow = {
  name: string
  driver: string
  mountpoint: string
  createdLabel: string
  usedBy: string[]
  stack: string | null
}

const helper = columnHelperFor<VolumeRow>()

function buildColumns(i18n: I18n, canManage: boolean, environmentId: number | undefined, canBrowse = false) {
  const { t } = i18n
  return helper.columns([
    helper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.volumes.columns.name} />,
      cell: ({ row }) => <Mono className="block max-w-72 truncate font-medium">{row.original.name}</Mono>,
      enableHiding: false,
    }),
    helper.accessor("stack", {
      header: t.volumes.columns.stack,
      cell: ({ row }) => row.original.stack ?? <span className="text-muted-foreground">—</span>,
    }),
    helper.accessor((r) => r.usedBy.length, {
      id: "used by",
      header: ({ column }) => <SortHeader column={column} title={t.volumes.columns.usedBy} />,
      cell: ({ row }) =>
        row.original.usedBy.length ? (
          <span className="text-sm">{row.original.usedBy.join(", ")}</span>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            {t.volumes.unused}
          </Badge>
        ),
    }),
    helper.accessor("driver", { header: t.volumes.columns.driver }),
    helper.accessor("mountpoint", {
      header: t.volumes.columns.mountpoint,
      cell: ({ row }) => <Mono className="block max-w-72 truncate text-muted-foreground">{row.original.mountpoint}</Mono>,
    }),
    helper.accessor("createdLabel", {
      header: t.volumes.columns.created,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdLabel}</span>,
    }),
    helper.display({
      id: "actions",
      cell: ({ row }) =>
        canManage || canBrowse ? (
          <div className="flex justify-end">
            {canBrowse ? (
              <Button asChild variant="ghost" size="icon" className="size-8 text-muted-foreground">
                <Link href={`/volumes/${encodeURIComponent(row.original.name)}`} aria-label={i18n.format(t.volumes.browseLabel, { name: row.original.name })}>
                  <FolderOpenIcon />
                </Link>
              </Button>
            ) : null}
            {canManage ? (
              <ConfirmAction
                title={i18n.format(t.volumes.removeTitle, { name: row.original.name })}
                description={t.volumes.removeDescription}
                confirmLabel={t.common.actions.remove}
                onConfirm={() => removeVolume(row.original.name, environmentId)}
              >
                <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t.volumes.removeLabel}>
                  <Trash2Icon />
                </Button>
              </ConfirmAction>
            ) : null}
          </div>
        ) : null,
      enableHiding: false,
    }),
  ])
}

const volumeSelection = (i18n: I18n, environmentId: number | undefined): TableSelection<VolumeRow> => ({
  rowLabel: (r) => r.name,
  actions: (selected, clear) => {
    const inUse = selected.filter((r) => r.usedBy.length).length
    return (
      <BulkConfirm
        label={i18n.t.common.actions.remove}
        icon={<Trash2Icon data-icon="inline-start" />}
        title={i18n.format(i18n.t.volumes.bulkRemoveTitle, { count: selected.length })}
        description={i18n.t.volumes.bulkRemoveDescription}
        names={selected.map((r) => r.name)}
        warning={inUse ? i18n.format(i18n.t.volumes.bulkRemoveWarning, { count: inUse }) : null}
        onConfirm={() => removeVolumes(selected.map((r) => r.name), environmentId)}
        onDone={clear}
      />
    )
  },
})

export function VolumesTable({ data, canManage, canBrowse }: { data: VolumeRow[]; canManage: boolean; canBrowse?: boolean }) {
  const i18n = useI18n()
  const { t } = i18n
  const environmentId = useEnvironmentId()
  const columns = React.useMemo(() => buildColumns(i18n, canManage, environmentId, canBrowse), [i18n, canManage, environmentId, canBrowse])
  const selection = React.useMemo(() => (canManage ? volumeSelection(i18n, environmentId) : undefined), [i18n, canManage, environmentId])
  const c = t.volumes.columns
  const columnLabels = { stack: c.stack, "used by": c.usedBy, driver: c.driver, mountpoint: c.mountpoint, createdLabel: c.created }
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.name}
      selection={selection}
      searchText={(r) => `${r.name} ${r.stack ?? ""} ${r.usedBy.join(" ")}`}
      searchPlaceholder={t.volumes.searchPlaceholder}
      emptyMessage={t.volumes.empty}
      columnLabels={columnLabels}
      pageSize={20}
      toolbar={
        canManage ? (
          <FormDialog
            trigger={
              <Button size="sm">
                <PlusIcon data-icon="inline-start" />
                <span className="max-lg:sr-only">{t.volumes.add}</span>
              </Button>
            }
            title={t.volumes.createTitle}
            submitLabel={t.common.actions.create}
            action={createVolume}
          >
            {(errors) => (
              <>
                <Field data-invalid={errors.name ? true : undefined}>
                  <FieldLabel htmlFor="v-name">{t.common.fields.name}</FieldLabel>
                  <Input id="v-name" name="name" placeholder="app-data" required autoFocus />
                  <FieldError>{errors.name?.[0]}</FieldError>
                </Field>
                <Field>
                  <FieldLabel htmlFor="v-driver">{t.common.fields.driver}</FieldLabel>
                  <Input id="v-driver" name="driver" defaultValue="local" />
                </Field>
              </>
            )}
          </FormDialog>
        ) : null
      }
    />
  )
}
