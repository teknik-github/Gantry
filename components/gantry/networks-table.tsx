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
import { useI18n } from "@/lib/i18n/client"
import type { I18n } from "@/lib/i18n"
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

function buildColumns(i18n: I18n, canManage: boolean, environmentId: number | undefined) {
  const { t } = i18n
  return helper.columns([
    helper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.networks.columns.name} />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2 font-medium">
          {row.original.name}
          {row.original.builtin ? (
            <Badge variant="outline" className="text-muted-foreground">
              {t.networks.builtin}
            </Badge>
          ) : null}
          {row.original.internal ? (
            <Badge variant="outline" className="text-muted-foreground">
              {t.networks.internal}
            </Badge>
          ) : null}
        </div>
      ),
      enableHiding: false,
    }),
    helper.accessor("driver", { header: ({ column }) => <SortHeader column={column} title={t.networks.columns.driver} /> }),
    helper.accessor("scope", { header: t.networks.columns.scope }),
    helper.accessor("subnet", {
      header: t.networks.columns.subnet,
      cell: ({ row }) => <Mono>{row.original.subnet || "—"}</Mono>,
    }),
    helper.accessor("gateway", {
      header: t.networks.columns.gateway,
      cell: ({ row }) => <Mono>{row.original.gateway || "—"}</Mono>,
    }),
    helper.accessor("containers", {
      header: ({ column }) => <SortHeader column={column} title={t.networks.columns.containers} />,
      cell: ({ row }) => <span className="tabular-nums">{row.original.containers}</span>,
    }),
    helper.display({
      id: "actions",
      cell: ({ row }) =>
        canManage && !row.original.builtin ? (
          <div className="flex justify-end">
            <ConfirmAction
              title={i18n.format(t.networks.removeTitle, { name: row.original.name })}
              description={t.networks.removeDescription}
              confirmLabel={t.common.actions.remove}
              onConfirm={() => removeNetwork(row.original.id, row.original.name, environmentId)}
            >
              <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t.networks.removeLabel}>
                <Trash2Icon />
              </Button>
            </ConfirmAction>
          </div>
        ) : null,
      enableHiding: false,
    }),
  ])
}

const networkSelection = (i18n: I18n, environmentId: number | undefined): TableSelection<NetworkRow> => ({
  canSelect: (r) => !r.builtin,
  rowLabel: (r) => r.name,
  actions: (selected, clear) => {
    const attached = selected.filter((r) => r.containers > 0).length
    return (
      <BulkConfirm
        label={i18n.t.common.actions.remove}
        icon={<Trash2Icon data-icon="inline-start" />}
        title={i18n.format(i18n.t.networks.bulkRemoveTitle, { count: selected.length })}
        description={i18n.t.networks.bulkRemoveDescription}
        names={selected.map((r) => r.name)}
        warning={attached ? i18n.format(i18n.t.networks.bulkRemoveWarning, { count: attached }) : null}
        onConfirm={() => removeNetworks(selected.map((r) => ({ id: r.id, name: r.name })), environmentId)}
        onDone={clear}
      />
    )
  },
})

export function NetworksTable({ data, canManage }: { data: NetworkRow[]; canManage: boolean }) {
  const i18n = useI18n()
  const { t } = i18n
  const environmentId = useEnvironmentId()
  const columns = React.useMemo(() => buildColumns(i18n, canManage, environmentId), [i18n, canManage, environmentId])
  const selection = React.useMemo(() => (canManage ? networkSelection(i18n, environmentId) : undefined), [i18n, canManage, environmentId])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      selection={selection}
      searchText={(r) => `${r.name} ${r.driver} ${r.subnet}`}
      searchPlaceholder={t.networks.searchPlaceholder}
      emptyMessage={t.networks.empty}
      columnLabels={t.networks.columns}
      pageSize={20}
      toolbar={
        canManage ? (
          <FormDialog
            trigger={
              <Button size="sm">
                <PlusIcon data-icon="inline-start" />
                <span className="max-lg:sr-only">{t.networks.add}</span>
              </Button>
            }
            title={t.networks.createTitle}
            submitLabel={t.common.actions.create}
            action={createNetwork}
          >
            {(errors) => (
              <>
                <Field data-invalid={errors.name ? true : undefined}>
                  <FieldLabel htmlFor="n-name">{t.common.fields.name}</FieldLabel>
                  <Input id="n-name" name="name" placeholder="backend" required autoFocus />
                  <FieldError>{errors.name?.[0]}</FieldError>
                </Field>
                <Field>
                  <FieldLabel htmlFor="n-driver">{t.common.fields.driver}</FieldLabel>
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
