"use client"

import * as React from "react"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { addHelmRepository, removeHelmRepository } from "@/app/(app)/kubernetes/helm-actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export type HelmRepoRow = { id: number; name: string; url: string; oci: boolean; username: string | null; updatedLabel: string }

type Errors = Record<string, string[] | undefined>

const helper = columnHelperFor<HelmRepoRow>()

const columns = helper.columns([
  helper.accessor("name", {
    header: ({ column }) => <SortHeader column={column} title="Name" />,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    enableHiding: false,
  }),
  helper.accessor("url", {
    header: "Address",
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <Badge variant="outline">{row.original.oci ? "OCI" : "index"}</Badge>
        <Mono>{row.original.url}</Mono>
      </span>
    ),
  }),
  helper.accessor("username", {
    header: "Login",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.username ?? "anonymous"}</span>,
  }),
  helper.accessor("updatedLabel", {
    header: "Added",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.updatedLabel}</span>,
  }),
  helper.display({
    id: "actions",
    cell: ({ row }) => (
      <div className="flex justify-end">
        <ConfirmAction
          title={`Remove chart repository ${row.original.name}?`}
          description="Installed releases are not affected; upgrades then need another source for their chart."
          confirmLabel="Remove"
          onConfirm={() => removeHelmRepository(row.original.id)}
        >
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Remove ${row.original.name}`}>
            <Trash2Icon />
          </Button>
        </ConfirmAction>
      </div>
    ),
    enableHiding: false,
  }),
])

/** Chart repositories (administrators): add with optional basic auth, remove. */
export function HelmReposTable({ data }: { data: HelmRepoRow[] }) {
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => `${r.name} ${r.url}`}
      searchPlaceholder="Search repositories…"
      emptyMessage="No chart repositories yet."
      toolbar={
        <FormDialog
          trigger={
            <Button size="sm">
              <PlusIcon data-icon="inline-start" />
              <span className="hidden lg:inline">Add repository</span>
            </Button>
          }
          title="Add chart repository"
          description="An index repository (its index is downloaded to check it) or an OCI registry path."
          submitLabel="Add"
          action={addHelmRepository}
        >
          {(errors) => <RepoFields errors={errors} />}
        </FormDialog>
      }
    />
  )
}

function RepoFields({ errors }: { errors: Errors }) {
  const uid = React.useId()
  return (
    <FieldGroup className="gap-4">
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-name`}>Name</FieldLabel>
        <Input id={`${uid}-name`} name="name" placeholder="bitnami" autoComplete="off" spellCheck={false} required autoFocus />
        <FieldDescription>Charts are referred to as name/chart.</FieldDescription>
        <FieldError>{errors.name?.[0]}</FieldError>
      </Field>
      <Field data-invalid={errors.url ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-url`}>URL</FieldLabel>
        <Input
          id={`${uid}-url`}
          name="url"
          placeholder="https://charts.example.com or oci://registry.example.com/charts"
          autoComplete="off"
          spellCheck={false}
          required
        />
        <FieldError>{errors.url?.[0]}</FieldError>
      </Field>
      <Field data-invalid={errors.username ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-username`}>Username (optional)</FieldLabel>
        <Input id={`${uid}-username`} name="username" autoComplete="off" spellCheck={false} />
        <FieldError>{errors.username?.[0]}</FieldError>
      </Field>
      <Field data-invalid={errors.password ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-password`}>Password or token (optional)</FieldLabel>
        <Input id={`${uid}-password`} name="password" type="password" autoComplete="new-password" />
        <FieldDescription>Stored encrypted; only handed to helm for the commands that need it.</FieldDescription>
        <FieldError>{errors.password?.[0]}</FieldError>
      </Field>
    </FieldGroup>
  )
}
