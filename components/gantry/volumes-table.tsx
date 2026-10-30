"use client"

import * as React from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { createVolume, removeVolume, removeVolumes } from "@/app/(app)/volumes/actions"
import { columnHelperFor, DataTable, SortHeader, type TableSelection } from "@/components/data-table"
import { BulkConfirm } from "@/components/gantry/bulk"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export type VolumeRow = {
  name: string
  driver: string
  mountpoint: string
  createdLabel: string
  usedBy: string[]
  stack: string | null
}

const helper = columnHelperFor<VolumeRow>()

function buildColumns(isAdmin: boolean) {
  return helper.columns([
    helper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => <Mono className="block max-w-72 truncate font-medium">{row.original.name}</Mono>,
      enableHiding: false,
    }),
    helper.accessor("stack", {
      header: "Stack",
      cell: ({ row }) => row.original.stack ?? <span className="text-muted-foreground">—</span>,
    }),
    helper.accessor((r) => r.usedBy.length, {
      id: "used by",
      header: ({ column }) => <SortHeader column={column} title="Used by" />,
      cell: ({ row }) =>
        row.original.usedBy.length ? (
          <span className="text-sm">{row.original.usedBy.join(", ")}</span>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            unused
          </Badge>
        ),
    }),
    helper.accessor("driver", { header: "Driver" }),
    helper.accessor("mountpoint", {
      header: "Mount point",
      cell: ({ row }) => <Mono className="block max-w-72 truncate text-muted-foreground">{row.original.mountpoint}</Mono>,
    }),
    helper.accessor("createdLabel", {
      header: "Created",
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdLabel}</span>,
    }),
    helper.display({
      id: "actions",
      cell: ({ row }) =>
        isAdmin ? (
          <div className="flex justify-end">
            <ConfirmAction
              title={`Remove volume ${row.original.name}?`}
              description="All data stored in this volume will be permanently deleted."
              confirmLabel="Remove"
              onConfirm={() => removeVolume(row.original.name)}
            >
              <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Remove volume">
                <Trash2Icon />
              </Button>
            </ConfirmAction>
          </div>
        ) : null,
      enableHiding: false,
    }),
  ])
}

const volumeSelection: TableSelection<VolumeRow> = {
  rowLabel: (r) => r.name,
  actions: (selected, clear) => {
    const inUse = selected.filter((r) => r.usedBy.length).length
    return (
      <BulkConfirm
        label="Remove"
        icon={<Trash2Icon data-icon="inline-start" />}
        title={`Remove ${selected.length} volume(s)?`}
        description="All data stored in these volumes will be permanently deleted."
        names={selected.map((r) => r.name)}
        warning={inUse ? `${inUse} of them are used by a container and will fail.` : null}
        onConfirm={() => removeVolumes(selected.map((r) => r.name))}
        onDone={clear}
      />
    )
  },
}

export function VolumesTable({ data, isAdmin }: { data: VolumeRow[]; isAdmin: boolean }) {
  const columns = React.useMemo(() => buildColumns(isAdmin), [isAdmin])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.name}
      selection={isAdmin ? volumeSelection : undefined}
      searchText={(r) => `${r.name} ${r.stack ?? ""} ${r.usedBy.join(" ")}`}
      searchPlaceholder="Search volumes…"
      emptyMessage="No volumes."
      pageSize={20}
      toolbar={
        isAdmin ? (
          <FormDialog
            trigger={
              <Button size="sm">
                <PlusIcon data-icon="inline-start" />
                <span className="hidden lg:inline">Add volume</span>
              </Button>
            }
            title="Create volume"
            submitLabel="Create"
            action={createVolume}
          >
            {(errors) => (
              <>
                <Field data-invalid={errors.name ? true : undefined}>
                  <FieldLabel htmlFor="v-name">Name</FieldLabel>
                  <Input id="v-name" name="name" placeholder="app-data" required autoFocus />
                  <FieldError>{errors.name?.[0]}</FieldError>
                </Field>
                <Field>
                  <FieldLabel htmlFor="v-driver">Driver</FieldLabel>
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
