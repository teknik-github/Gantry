"use client"

import * as React from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { createNetwork, removeNetwork, removeNetworks } from "@/app/(app)/networks/actions"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export type NetworkRow = {
  id: string
  name: string
  driver: string
  scope: string
  subnet: string
  gateway: string
  containers: number
  builtin: boolean
  internal: boolean
}

const helper = columnHelperFor<NetworkRow>()

function buildColumns(canManage: boolean, environmentId: number | undefined) {
  return helper.columns([
    helper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2 font-medium">
          {row.original.name}
          {row.original.builtin ? (
            <Badge variant="outline" className="text-muted-foreground">
              built-in
            </Badge>
          ) : null}
          {row.original.internal ? (
            <Badge variant="outline" className="text-muted-foreground">
              internal
            </Badge>
          ) : null}
        </div>
      ),
      enableHiding: false,
    }),
    helper.accessor("driver", { header: ({ column }) => <SortHeader column={column} title="Driver" /> }),
    helper.accessor("scope", { header: "Scope" }),
    helper.accessor("subnet", {
      header: "Subnet",
      cell: ({ row }) => <Mono>{row.original.subnet || "—"}</Mono>,
    }),
    helper.accessor("gateway", {
      header: "Gateway",
      cell: ({ row }) => <Mono>{row.original.gateway || "—"}</Mono>,
    }),
    helper.accessor("containers", {
      header: ({ column }) => <SortHeader column={column} title="Containers" />,
      cell: ({ row }) => <span className="tabular-nums">{row.original.containers}</span>,
    }),
    helper.display({
      id: "actions",
      cell: ({ row }) =>
        canManage && !row.original.builtin ? (
          <div className="flex justify-end">
            <ConfirmAction
              title={`Remove network ${row.original.name}?`}
              description="Containers must be disconnected from the network first."
              confirmLabel="Remove"
              onConfirm={() => removeNetwork(row.original.id, row.original.name, environmentId)}
            >
              <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Remove network">
                <Trash2Icon />
              </Button>
            </ConfirmAction>
          </div>
        ) : null,
      enableHiding: false,
    }),
  ])
}

const networkSelection = (environmentId: number | undefined): TableSelection<NetworkRow> => ({
  canSelect: (r) => !r.builtin,
  rowLabel: (r) => r.name,
  actions: (selected, clear) => {
    const attached = selected.filter((r) => r.containers > 0).length
    return (
      <BulkConfirm
        label="Remove"
        icon={<Trash2Icon data-icon="inline-start" />}
        title={`Remove ${selected.length} network(s)?`}
        description="Containers must be disconnected from a network before it can be removed."
        names={selected.map((r) => r.name)}
        warning={attached ? `${attached} of them still have containers attached and will fail.` : null}
        onConfirm={() => removeNetworks(selected.map((r) => ({ id: r.id, name: r.name })), environmentId)}
        onDone={clear}
      />
    )
  },
})

export function NetworksTable({ data, canManage }: { data: NetworkRow[]; canManage: boolean }) {
  const environmentId = useEnvironmentId()
  const columns = React.useMemo(() => buildColumns(canManage, environmentId), [canManage, environmentId])
  const selection = React.useMemo(() => (canManage ? networkSelection(environmentId) : undefined), [canManage, environmentId])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      selection={selection}
      searchText={(r) => `${r.name} ${r.driver} ${r.subnet}`}
      searchPlaceholder="Search networks…"
      emptyMessage="No networks."
      pageSize={20}
      toolbar={
        canManage ? (
          <FormDialog
            trigger={
              <Button size="sm">
                <PlusIcon data-icon="inline-start" />
                <span className="hidden lg:inline">Add network</span>
              </Button>
            }
            title="Create network"
            submitLabel="Create"
            action={createNetwork}
          >
            {(errors) => (
              <>
                <Field data-invalid={errors.name ? true : undefined}>
                  <FieldLabel htmlFor="n-name">Name</FieldLabel>
                  <Input id="n-name" name="name" placeholder="backend" required autoFocus />
                  <FieldError>{errors.name?.[0]}</FieldError>
                </Field>
                <Field>
                  <FieldLabel htmlFor="n-driver">Driver</FieldLabel>
                  <Select name="driver" defaultValue="bridge">
                    <SelectTrigger id="n-driver" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["bridge", "overlay", "macvlan", "ipvlan"].map((d) => (
                        <SelectItem key={d} value={d}>
                          {d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </>
            )}
          </FormDialog>
        ) : null
      }
    />
  )
}
