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

export type RegistryRow = {
  id: number
  name: string
  address: string
  username: string
  updatedLabel: string
}

type Errors = Record<string, string[] | undefined>

const helper = columnHelperFor<RegistryRow>()

const columns = helper.columns([
  helper.accessor("name", {
    header: ({ column }) => <SortHeader column={column} title="Name" />,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    enableHiding: false,
  }),
  helper.accessor("address", {
    header: ({ column }) => <SortHeader column={column} title="Registry" />,
    cell: ({ row }) => <Mono>{row.original.address}</Mono>,
  }),
  helper.accessor("username", { header: "Username" }),
  helper.accessor("updatedLabel", {
    header: "Updated",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.updatedLabel}</span>,
  }),
  helper.display({
    id: "actions",
    cell: ({ row }) => <RowActions row={row.original} />,
    enableHiding: false,
  }),
])

export function RegistriesTable({ data }: { data: RegistryRow[] }) {
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => `${r.name} ${r.address} ${r.username}`}
      searchPlaceholder="Search registries…"
      emptyMessage="No registry logins yet. Public images need none."
      toolbar={
        <FormDialog
          trigger={
            <Button size="sm">
              <PlusIcon data-icon="inline-start" />
              <span className="hidden lg:inline">Add registry</span>
            </Button>
          }
          title="Add registry"
          description="The login is used for every image from this registry."
          submitLabel="Save"
          action={createRegistry}
        >
          {(errors) => <RegistryFields errors={errors} />}
        </FormDialog>
      }
    />
  )
}

function RowActions({ row }: { row: RegistryRow }) {
  const [pending, run] = useRunAction()
  return (
    <div className="flex justify-end gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 text-muted-foreground"
        aria-label={`Test login to ${row.address}`}
        disabled={pending}
        onClick={() => run(() => testRegistry(row.id))}
      >
        <PlugZapIcon />
      </Button>
      <FormDialog
        trigger={
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Edit ${row.name}`}>
            <PencilIcon />
          </Button>
        }
        title={`Edit ${row.name}`}
        submitLabel="Save"
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
        title={`Remove the login for ${row.address}?`}
        description="Pulls from this registry will be anonymous again."
        confirmLabel="Remove"
        onConfirm={() => deleteRegistry(row.id)}
      >
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Remove ${row.name}`}>
          <Trash2Icon />
        </Button>
      </ConfirmAction>
    </div>
  )
}

function RegistryFields({ errors, initial }: { errors: Errors; initial?: RegistryRow }) {
  return (
    <FieldGroup className="gap-4">
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor="r-name">Name</FieldLabel>
        <Input id="r-name" name="name" defaultValue={initial?.name} placeholder="GitHub packages" required autoFocus />
        <FieldError>{errors.name?.[0]}</FieldError>
      </Field>
      <Field data-invalid={errors.address ? true : undefined}>
        <FieldLabel htmlFor="r-address">Registry</FieldLabel>
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
          Host as it appears in image names: <code>ghcr.io</code>, <code>registry.gitlab.com</code>,{" "}
          <code>registry.example.com:5000</code>, or <code>docker.io</code> for Docker Hub.
        </FieldDescription>
        <FieldError>{errors.address?.[0]}</FieldError>
      </Field>
      <Field data-invalid={errors.username ? true : undefined}>
        <FieldLabel htmlFor="r-username">Username</FieldLabel>
        <Input id="r-username" name="username" defaultValue={initial?.username} autoComplete="off" required />
        <FieldError>{errors.username?.[0]}</FieldError>
      </Field>
      <Field data-invalid={errors.password ? true : undefined}>
        <FieldLabel htmlFor="r-password">Password or access token</FieldLabel>
        <Input
          id="r-password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder={initial ? "Leave empty to keep the current one" : undefined}
          required={!initial}
        />
        <FieldDescription>Stored encrypted. Prefer a read-only token (e.g. a GitHub PAT with read:packages).</FieldDescription>
        <FieldError>{errors.password?.[0]}</FieldError>
      </Field>
      <Label className="font-normal">
        <Checkbox name="verify" value="on" defaultChecked />
        Check the login before saving
      </Label>
    </FieldGroup>
  )
}
