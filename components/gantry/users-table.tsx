"use client"

import * as React from "react"
import { KeyRoundIcon, PlusIcon, ServerIcon, ShieldOffIcon, Trash2Icon } from "lucide-react"

import { createUser, deleteUser, resetPassword, resetTwoFactor, setUserAccess, setUserRole } from "@/app/(app)/users/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { AccessDialog, RoleBadge } from "@/components/gantry/access-dialog"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { FormDialog } from "@/components/gantry/form-dialog"
import { useRunAction } from "@/components/gantry/use-action"
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
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import type { EnvironmentRole } from "@/lib/permissions"

export type UserRow = {
  id: number
  username: string
  role: "admin" | "user"
  createdLabel: string
  self: boolean
  /** Environments a standard user was granted, with the role (ignored for administrators). */
  grants: { id: number; role: EnvironmentRole }[]
  twoFactor: boolean
  /** Linked to a single sign-on identity. */
  sso: boolean
}

type EnvironmentOption = { id: number; name: string }

const userHelper = columnHelperFor<UserRow>()

function userColumns(environments: EnvironmentOption[], i18n: I18n) {
  const { t, format } = i18n
  const names = new Map(environments.map((e) => [e.id, e.name]))
  return userHelper.columns([
    userHelper.accessor("username", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.username} />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2 font-medium">
          {row.original.username}
          {row.original.self ? <Badge variant="secondary">{t.users.you}</Badge> : null}
          {row.original.twoFactor ? (
            <Badge variant="outline" className="text-muted-foreground" title={t.users.twoFactorOn}>
              2FA
            </Badge>
          ) : null}
          {row.original.sso ? (
            <Badge variant="outline" className="text-muted-foreground" title={t.users.ssoLinked}>
              SSO
            </Badge>
          ) : null}
        </div>
      ),
      enableHiding: false,
    }),
    userHelper.accessor("role", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.role} />,
      cell: ({ row }) => <RoleSelect row={row.original} />,
    }),
    userHelper.display({
      id: "environments",
      header: t.users.columns.environments,
      cell: ({ row }) => {
        const testId = `user-envs-${row.original.username}`
        if (row.original.role === "admin") {
          return (
            <span className="text-muted-foreground" data-testid={testId}>
              {t.users.all}
            </span>
          )
        }
        const granted = row.original.grants.flatMap((g) => {
          const name = names.get(g.id)
          return name ? [{ ...g, name }] : []
        })
        return granted.length ? (
          <div className="flex max-w-72 flex-wrap gap-1" data-testid={testId}>
            {granted.map((g) => (
              <RoleBadge key={g.id} name={g.name} role={g.role} />
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground" data-testid={testId}>
            {t.users.none}
          </span>
        )
      },
    }),
    userHelper.accessor("createdLabel", {
      header: t.common.fields.created,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdLabel}</span>,
    }),
    userHelper.display({
      id: "actions",
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          {row.original.role === "user" ? (
            <AccessDialog
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground"
                  aria-label={format(t.users.accessLabel, { username: row.original.username })}
                >
                  <ServerIcon />
                </Button>
              }
              title={format(t.users.accessTitle, { username: row.original.username })}
              description={t.users.accessDescription}
              action={setUserAccess}
              id={row.original.id}
              fieldName="env"
              options={environments.map((e) => ({ id: e.id, label: e.name }))}
              selected={row.original.grants}
              emptyMessage={t.users.noEnvironments}
            />
          ) : null}
          <ResetPasswordDialog row={row.original} />
          {row.original.twoFactor ? (
            <ConfirmAction
              title={format(t.users.resetTwoFactorTitle, { username: row.original.username })}
              description={t.users.resetTwoFactorDescription}
              confirmLabel={t.users.reset}
              onConfirm={() => resetTwoFactor(row.original.id)}
            >
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                aria-label={format(t.users.resetTwoFactorLabel, { username: row.original.username })}
              >
                <ShieldOffIcon />
              </Button>
            </ConfirmAction>
          ) : null}
          {!row.original.self ? (
            <ConfirmAction
              title={format(t.users.deleteTitle, { username: row.original.username })}
              description={t.users.deleteDescription}
              confirmLabel={t.common.actions.delete}
              onConfirm={() => deleteUser(row.original.id)}
            >
              <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t.users.deleteLabel}>
                <Trash2Icon />
              </Button>
            </ConfirmAction>
          ) : null}
        </div>
      ),
      enableHiding: false,
    }),
  ])
}

function RoleSelect({ row }: { row: UserRow }) {
  const [pending, run] = useRunAction()
  const { t } = useI18n()
  return (
    <Select
      value={row.role}
      disabled={pending}
      onValueChange={(role) => run(() => setUserRole(row.id, role as UserRow["role"]))}
    >
      <SelectTrigger size="sm" className="w-36" aria-label={t.common.fields.role}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="admin">{t.common.roles.admin}</SelectItem>
        <SelectItem value="user">{t.common.roles.user}</SelectItem>
      </SelectContent>
    </Select>
  )
}

function ResetPasswordDialog({ row }: { row: UserRow }) {
  const { t, format } = useI18n()
  return (
    <FormDialog
      trigger={
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t.users.resetPassword}>
          <KeyRoundIcon />
        </Button>
      }
      title={format(t.users.setPasswordTitle, { username: row.username })}
      submitLabel={t.users.setPassword}
      action={resetPassword}
    >
      {(errors) => (
        <Field data-invalid={errors.password ? true : undefined}>
          <input type="hidden" name="id" value={row.id} />
          <FieldLabel htmlFor={`pw-${row.id}`}>{t.users.newPassword}</FieldLabel>
          <Input id={`pw-${row.id}`} name="password" type="password" autoComplete="new-password" required autoFocus />
          <FieldError>{errors.password?.[0]}</FieldError>
        </Field>
      )}
    </FormDialog>
  )
}

export function UsersTable({ data, environments }: { data: UserRow[]; environments: EnvironmentOption[] }) {
  const i18n = useI18n()
  const { t } = i18n
  const columns = React.useMemo(() => userColumns(environments, i18n), [environments, i18n])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => r.username}
      searchPlaceholder={t.users.searchPlaceholder}
      emptyMessage={t.users.empty}
      columnLabels={t.users.columns}
      toolbar={
        <FormDialog
          trigger={
            <Button size="sm">
              <PlusIcon data-icon="inline-start" />
              <span className="max-lg:sr-only">{t.users.add}</span>
            </Button>
          }
          title={t.users.add}
          description={t.users.addDescription}
          submitLabel={t.common.actions.create}
          action={createUser}
        >
          {(errors) => (
            <>
              <Field data-invalid={errors.username ? true : undefined}>
                <FieldLabel htmlFor="u-username">{t.common.fields.username}</FieldLabel>
                <Input id="u-username" name="username" autoComplete="off" required autoFocus />
                <FieldError>{errors.username?.[0]}</FieldError>
              </Field>
              <Field data-invalid={errors.password ? true : undefined}>
                <FieldLabel htmlFor="u-password">{t.common.fields.password}</FieldLabel>
                <Input id="u-password" name="password" type="password" autoComplete="new-password" required />
                <FieldError>{errors.password?.[0]}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="u-role">{t.common.fields.role}</FieldLabel>
                <Select name="role" defaultValue="user">
                  <SelectTrigger id="u-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">{t.common.roles.user}</SelectItem>
                    <SelectItem value="admin">{t.common.roles.admin}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </>
          )}
        </FormDialog>
      }
    />
  )
}
