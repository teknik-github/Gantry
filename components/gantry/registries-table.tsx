"use client"

import * as React from "react"
import { PencilIcon, PlugZapIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { createRegistry, deleteRegistry, testRegistry, updateRegistry } from "@/app/(app)/registries/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono } from "@/components/gantry/ui"
import { useRunAction } from "@/components/gantry/use-action"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"

export type RegistryRow = {
  id: number
  name: string
  address: string
  username: string
  updatedLabel: string
}

type Errors = Record<string, string[] | undefined>

const helper = columnHelperFor<RegistryRow>()

function buildColumns({ t }: I18n) {
  return helper.columns([
    helper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    helper.accessor("address", {
      header: ({ column }) => <SortHeader column={column} title={t.registries.columns.address} />,
      cell: ({ row }) => <Mono>{row.original.address}</Mono>,
    }),
    helper.accessor("username", { header: t.registries.columns.username }),
    helper.accessor("updatedLabel", {
      header: t.registries.columns.updatedLabel,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.updatedLabel}</span>,
    }),
    helper.display({
      id: "actions",
      cell: ({ row }) => <RowActions row={row.original} />,
      enableHiding: false,
    }),
  ])
}

export function RegistriesTable({ data }: { data: RegistryRow[] }) {
  const i18n = useI18n()
  const { t } = i18n
  const columns = React.useMemo(() => buildColumns(i18n), [i18n])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => `${r.name} ${r.address} ${r.username}`}
      searchPlaceholder={t.registries.searchPlaceholder}
      emptyMessage={t.registries.empty}
      columnLabels={t.registries.columns}
      toolbar={
        <FormDialog
          trigger={
            <Button size="sm">
              <PlusIcon data-icon="inline-start" />
              <span className="hidden lg:inline">{t.registries.add}</span>
            </Button>
          }
          title={t.registries.add}
          description={t.registries.addDescription}
          submitLabel={t.common.actions.save}
          action={createRegistry}
        >
          {(errors) => <RegistryFields errors={errors} />}
        </FormDialog>
      }
    />
  )
}

function RowActions({ row }: { row: RegistryRow }) {
  const { t, format } = useI18n()
  const [pending, run] = useRunAction()
  return (
    <div className="flex justify-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        aria-label={format(t.registries.testLogin, { address: row.address })}
        disabled={pending}
        onClick={() => run(() => testRegistry(row.id))}
      >
        <PlugZapIcon />
      </Button>
      <FormDialog
        trigger={
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={format(t.registries.editName, { name: row.name })}>
            <PencilIcon />
          </Button>
        }
        title={format(t.registries.editName, { name: row.name })}
        submitLabel={t.common.actions.save}
        action={updateRegistry}
      >
        {(errors) => (
          <>
            <input type="hidden" name="id" value={row.id} />
            <RegistryFields errors={errors} initial={row} />
          </>
        )}
      </FormDialog>
      <ConfirmAction
        title={format(t.registries.removeTitle, { address: row.address })}
        description={t.registries.removeDescription}
        confirmLabel={t.common.actions.remove}
        onConfirm={() => deleteRegistry(row.id)}
      >
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={format(t.registries.removeName, { name: row.name })}>
          <Trash2Icon />
        </Button>
      </ConfirmAction>
    </div>
  )
}

function RegistryFields({ errors, initial }: { errors: Errors; initial?: RegistryRow }) {
  const i18n = useI18n()
  const f = i18n.t.registries.fields
  return (
    <FieldGroup className="gap-4">
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor="r-name">{f.name}</FieldLabel>
        <Input id="r-name" name="name" defaultValue={initial?.name} placeholder={f.namePlaceholder} required autoFocus />
        <FieldError>{errors.name?.[0]}</FieldError>
      </Field>
      <Field data-invalid={errors.address ? true : undefined}>
        <FieldLabel htmlFor="r-address">{f.registry}</FieldLabel>
        <Input
          id="r-address"
          name="address"
          defaultValue={initial?.address}
          placeholder="ghcr.io"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <FieldDescription>
          {i18n.rich(f.registryHelp, {
            ghcr: <code>ghcr.io</code>,
            gitlab: <code>registry.gitlab.com</code>,
            example: <code>registry.example.com:5000</code>,
            dockerHub: <code>docker.io</code>,
          })}
        </FieldDescription>
        <FieldError>{errors.address?.[0]}</FieldError>
      </Field>
      <Field data-invalid={errors.username ? true : undefined}>
        <FieldLabel htmlFor="r-username">{f.username}</FieldLabel>
        <Input id="r-username" name="username" defaultValue={initial?.username} autoComplete="off" required />
        <FieldError>{errors.username?.[0]}</FieldError>
      </Field>
      <Field data-invalid={errors.password ? true : undefined}>
        <FieldLabel htmlFor="r-password">{f.password}</FieldLabel>
        <Input
          id="r-password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder={initial ? f.passwordKeep : undefined}
          required={!initial}
        />
        <FieldDescription>{f.passwordHelp}</FieldDescription>
        <FieldError>{errors.password?.[0]}</FieldError>
      </Field>
      <Label className="font-normal">
        <Checkbox name="verify" value="on" defaultChecked />
        {f.verify}
      </Label>
    </FieldGroup>
  )
}
