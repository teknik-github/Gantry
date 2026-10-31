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
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"

export type HelmRepoRow = { id: number; name: string; url: string; oci: boolean; username: string | null; updatedLabel: string }

type Errors = Record<string, string[] | undefined>

const helper = columnHelperFor<HelmRepoRow>()

function columns({ t, format }: I18n) {
  const k = t.kubernetes.repos
  return helper.columns([
    helper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    helper.accessor("url", {
      header: k.address,
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <Badge variant="outline">{row.original.oci ? "OCI" : "index"}</Badge>
          <Mono>{row.original.url}</Mono>
        </span>
      ),
    }),
    helper.accessor("username", {
      header: k.login,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.username ?? k.anonymous}</span>,
    }),
    helper.accessor("updatedLabel", {
      header: k.added,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.updatedLabel}</span>,
    }),
    helper.display({
      id: "actions",
      cell: ({ row }) => (
        <div className="flex justify-end">
          <ConfirmAction
            title={format(k.removeTitle, { name: row.original.name })}
            description={k.removeDescription}
            confirmLabel={t.common.actions.remove}
            onConfirm={() => removeHelmRepository(row.original.id)}
          >
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={format(k.removeLabel, { name: row.original.name })}>
              <Trash2Icon />
            </Button>
          </ConfirmAction>
        </div>
      ),
      enableHiding: false,
    }),
  ])
}

/** Chart repositories (administrators): add with optional basic auth, remove. */
export function HelmReposTable({ data }: { data: HelmRepoRow[] }) {
  const i18n = useI18n()
  const k = i18n.t.kubernetes.repos
  const cols = React.useMemo(() => columns(i18n), [i18n])
  return (
    <DataTable
      data={data}
      columns={cols}
      getRowId={(r) => String(r.id)}
      searchText={(r) => `${r.name} ${r.url}`}
      searchPlaceholder={k.search}
      emptyMessage={k.empty}
      columnLabels={i18n.locale === "en" ? undefined : { url: k.address, username: k.login, updatedLabel: k.added }}
      toolbar={
        <FormDialog
          trigger={
            <Button size="sm">
              <PlusIcon data-icon="inline-start" />
              <span className="hidden lg:inline">{k.add}</span>
            </Button>
          }
          title={k.addTitle}
          description={k.addDescription}
          submitLabel={i18n.t.common.actions.add}
          action={addHelmRepository}
        >
          {(errors) => <RepoFields errors={errors} />}
        </FormDialog>
      }
    />
  )
}

function RepoFields({ errors }: { errors: Errors }) {
  const { t } = useI18n()
  const k = t.kubernetes.repos
  const uid = React.useId()
  return (
    <FieldGroup className="gap-4">
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-name`}>{t.common.fields.name}</FieldLabel>
        <Input id={`${uid}-name`} name="name" placeholder="bitnami" autoComplete="off" spellCheck={false} required autoFocus />
        <FieldDescription>{k.nameHelp}</FieldDescription>
        <FieldError>{errors.name?.[0]}</FieldError>
      </Field>
      <Field data-invalid={errors.url ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-url`}>{t.common.fields.url}</FieldLabel>
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
        <FieldLabel htmlFor={`${uid}-username`}>{k.usernameOptional}</FieldLabel>
        <Input id={`${uid}-username`} name="username" autoComplete="off" spellCheck={false} />
        <FieldError>{errors.username?.[0]}</FieldError>
      </Field>
      <Field data-invalid={errors.password ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-password`}>{k.passwordOptional}</FieldLabel>
        <Input id={`${uid}-password`} name="password" type="password" autoComplete="new-password" />
        <FieldDescription>{k.passwordHelp}</FieldDescription>
        <FieldError>{errors.password?.[0]}</FieldError>
      </Field>
    </FieldGroup>
  )
}
