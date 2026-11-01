"use client"

import * as React from "react"
import { LockIcon, PencilIcon, PlusIcon, ShieldAlertIcon, Trash2Icon, UsersIcon } from "lucide-react"

import {
  createEnvironment,
  deleteEnvironment,
  setEnvironmentAccess,
  updateEnvironment,
} from "@/app/(app)/environments/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { AccessDialog, RoleBadge } from "@/components/gantry/access-dialog"
import {
  AddAgentDialog,
  AgentAddressCell,
  AgentEnrollmentProvider,
  AgentStatusBadge,
  AgentTypeCell,
  RotateAgentKeyButton,
  type AgentRow,
} from "@/components/gantry/agent-environment"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { credentialKind, EnvironmentFields } from "@/components/gantry/environment-fields"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import type { EnvironmentRole } from "@/lib/permissions"
import { cn } from "@/lib/utils"

export type EnvironmentRow = {
  id: number
  name: string
  type: "socket" | "tcp" | "agent" | "kubernetes"
  url: string
  /** Whether TLS certificates are stored. The PEM material itself never reaches the browser. */
  tls: boolean
  /** Kubernetes: kinds of stored credentials ("token", "client certificate", "CA"), never the values. */
  kubeAuth: string[]
  kubeInsecure: boolean
  kubeNamespace: string | null
  status: "up" | "down"
  /** "Docker 27.3.1" / "Kubernetes v1.34.0" */
  version: string | null
  error: string | null
  current: boolean
  /** "agent" only: connection state and what the agent reported. */
  agent: AgentRow | null
  /** Standard users granted access, with their role (administrators can always use it). */
  access: { id: number; username: string; role: EnvironmentRole }[]
}

type UserOption = { id: number; username: string }

const envHelper = columnHelperFor<EnvironmentRow>()

function environmentColumns(users: UserOption[], i18n: I18n) {
  const { t, format } = i18n
  const text = t.environments
  return envHelper.columns([
    envHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2 font-medium">
          {row.original.name}
          {row.original.current ? <Badge variant="secondary">{text.current}</Badge> : null}
        </div>
      ),
      enableHiding: false,
    }),
    envHelper.accessor("status", {
      header: text.columns.status,
      cell: ({ row }) =>
        row.original.agent ? (
          <AgentStatusBadge agent={row.original.agent} version={row.original.version} error={row.original.error} />
        ) : (
          <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground" title={row.original.error ?? undefined}>
            <span className={cn("size-2 rounded-full", row.original.status === "up" ? "bg-emerald-500" : "bg-red-500")} />
            {row.original.status === "up" ? format(text.up, { version: row.original.version ?? "" }) : text.unreachable}
          </Badge>
        ),
    }),
    envHelper.accessor("type", {
      header: text.columns.type,
      cell: ({ row }) =>
        row.original.type === "socket" ? (
          text.types.socket
        ) : row.original.agent ? (
          <AgentTypeCell agent={row.original.agent} />
        ) : row.original.type === "kubernetes" ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {text.types.kubernetes}
            {row.original.kubeAuth
              .filter((a) => a !== "CA")
              .map((a) => (
                <Badge key={a} variant="outline" className="px-1.5 text-muted-foreground">
                  {credentialKind(a, t)}
                </Badge>
              ))}
            {row.original.kubeInsecure ? (
              <Badge variant="outline" className="gap-1 px-1.5 text-amber-600" title={text.tlsVerifyOffTitle}>
                <ShieldAlertIcon />
                {text.tlsVerifyOff}
              </Badge>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {text.types.tcp}
            {row.original.tls ? (
              <Badge variant="outline" className="gap-1 px-1.5 text-muted-foreground">
                <LockIcon />
                {text.tls}
              </Badge>
            ) : null}
          </div>
        ),
    }),
    envHelper.accessor("url", {
      header: text.columns.url,
      cell: ({ row }) => (row.original.agent ? <AgentAddressCell agent={row.original.agent} /> : <Mono>{row.original.url}</Mono>),
    }),
    envHelper.display({
      id: "access",
      header: text.columns.access,
      cell: ({ row }) =>
        row.original.access.length ? (
          <div className="flex max-w-72 flex-wrap gap-1" data-testid={`env-access-${row.original.name}`}>
            {row.original.access.map((u) => (
              <RoleBadge key={u.id} name={u.username} role={u.role} />
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground" data-testid={`env-access-${row.original.name}`}>
            {text.adminsOnly}
          </span>
        ),
    }),
    envHelper.display({
      id: "actions",
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <AccessDialog
            trigger={
              <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={text.manageAccess}>
                <UsersIcon />
              </Button>
            }
            title={format(text.accessTitle, { name: row.original.name })}
            description={text.accessDescription}
            action={setEnvironmentAccess}
            id={row.original.id}
            fieldName="user"
            options={users.map((u) => ({ id: u.id, label: u.username }))}
            selected={row.original.access.map((u) => ({ id: u.id, role: u.role }))}
            emptyMessage={text.noStandardUsers}
          />
          {row.original.agent ? <RotateAgentKeyButton id={row.original.id} name={row.original.name} /> : null}
          <EditEnvironmentDialog row={row.original} />
          <ConfirmAction
            title={format(text.removeTitle, { name: row.original.name })}
            description={
              row.original.type === "kubernetes" ? text.removeKubernetes : row.original.agent ? text.removeAgent : text.removeDocker
            }
            confirmLabel={t.common.actions.remove}
            onConfirm={() => deleteEnvironment(row.original.id)}
          >
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={text.removeLabel}>
              <Trash2Icon />
            </Button>
          </ConfirmAction>
        </div>
      ),
      enableHiding: false,
    }),
  ])
}

export function EnvironmentsTable({ data, users }: { data: EnvironmentRow[]; users: UserOption[] }) {
  const i18n = useI18n()
  const columns = React.useMemo(() => environmentColumns(users, i18n), [users, i18n])
  return (
    <AgentEnrollmentProvider>
      <DataTable
        data={data}
        columns={columns}
        getRowId={(r) => String(r.id)}
        emptyMessage={i18n.t.environments.empty}
        columnLabels={i18n.t.environments.columns}
        toolbar={
          <>
            <AddAgentDialog />
            <AddEnvironmentDialog />
          </>
        }
      />
    </AgentEnrollmentProvider>
  )
}

const ENV_DIALOG_CLASS = "max-h-[90vh] overflow-y-auto sm:max-w-xl"

function AddEnvironmentDialog() {
  const { t } = useI18n()
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon data-icon="inline-start" />
          <span className="hidden lg:inline">{t.environments.add}</span>
        </Button>
      }
      title={t.environments.add}
      description={t.environments.addDescription}
      submitLabel={t.environments.connect}
      action={createEnvironment}
      className={ENV_DIALOG_CLASS}
    >
      {(errors) => <EnvironmentFields errors={errors} />}
    </FormDialog>
  )
}

function EditEnvironmentDialog({ row }: { row: EnvironmentRow }) {
  const { t, format } = useI18n()
  return (
    <FormDialog
      trigger={
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t.environments.editLabel}>
          <PencilIcon />
        </Button>
      }
      title={format(t.environments.editTitle, { name: row.name })}
      description={t.environments.editDescription}
      submitLabel={t.common.actions.save}
      action={updateEnvironment}
      className={ENV_DIALOG_CLASS}
    >
      {(errors) => <EnvironmentFields errors={errors} initial={row} />}
    </FormDialog>
  )
}
