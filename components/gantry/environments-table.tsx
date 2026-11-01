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
import { EnvironmentFields } from "@/components/gantry/environment-fields"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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

function environmentColumns(users: UserOption[]) {
  return envHelper.columns([
    envHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2 font-medium">
          {row.original.name}
          {row.original.current ? <Badge variant="secondary">current</Badge> : null}
        </div>
      ),
      enableHiding: false,
    }),
    envHelper.accessor("status", {
      header: "Status",
      cell: ({ row }) =>
        row.original.agent ? (
          <AgentStatusBadge agent={row.original.agent} version={row.original.version} error={row.original.error} />
        ) : (
          <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground" title={row.original.error ?? undefined}>
            <span className={cn("size-2 rounded-full", row.original.status === "up" ? "bg-emerald-500" : "bg-red-500")} />
            {row.original.status === "up" ? `up · ${row.original.version}` : "unreachable"}
          </Badge>
        ),
    }),
    envHelper.accessor("type", {
      header: "Type",
      cell: ({ row }) =>
        row.original.type === "socket" ? (
          "Unix socket"
        ) : row.original.agent ? (
          <AgentTypeCell agent={row.original.agent} />
        ) : row.original.type === "kubernetes" ? (
          <div className="flex flex-wrap items-center gap-1.5">
            Kubernetes
            {row.original.kubeAuth
              .filter((a) => a !== "CA")
              .map((a) => (
                <Badge key={a} variant="outline" className="px-1.5 text-muted-foreground">
                  {a}
                </Badge>
              ))}
            {row.original.kubeInsecure ? (
              <Badge variant="outline" className="gap-1 px-1.5 text-amber-600" title="The API server's certificate is not verified">
                <ShieldAlertIcon />
                TLS verify off
              </Badge>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            TCP
            {row.original.tls ? (
              <Badge variant="outline" className="gap-1 px-1.5 text-muted-foreground">
                <LockIcon />
                TLS
              </Badge>
            ) : null}
          </div>
        ),
    }),
    envHelper.accessor("url", {
      header: "Address",
      cell: ({ row }) => (row.original.agent ? <AgentAddressCell agent={row.original.agent} /> : <Mono>{row.original.url}</Mono>),
    }),
    envHelper.display({
      id: "access",
      header: "Access",
      cell: ({ row }) =>
        row.original.access.length ? (
          <div className="flex max-w-72 flex-wrap gap-1" data-testid={`env-access-${row.original.name}`}>
            {row.original.access.map((u) => (
              <RoleBadge key={u.id} name={u.username} role={u.role} />
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground" data-testid={`env-access-${row.original.name}`}>
            Admins only
          </span>
        ),
    }),
    envHelper.display({
      id: "actions",
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <AccessDialog
            trigger={
              <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Manage access">
                <UsersIcon />
              </Button>
            }
            title={`Access to ${row.original.name}`}
            description="Standard users who can use this environment, and what they may do. Administrators always can."
            action={setEnvironmentAccess}
            id={row.original.id}
            fieldName="user"
            options={users.map((u) => ({ id: u.id, label: u.username }))}
            selected={row.original.access.map((u) => ({ id: u.id, role: u.role }))}
            emptyMessage="There are no standard users yet."
          />
          {row.original.agent ? <RotateAgentKeyButton id={row.original.id} name={row.original.name} /> : null}
          <EditEnvironmentDialog row={row.original} />
          <ConfirmAction
            title={`Remove environment ${row.original.name}?`}
            description={
              row.original.type === "kubernetes"
                ? "Gantry will stop managing this cluster and forget its credentials. Nothing in the cluster is changed."
                : row.original.agent
                  ? "Gantry will stop managing this Docker host and forget the agent's key, so the agent is disconnected and can't come back. Remove the gantry-agent container on the host. Nothing else on the host is changed."
                  : "Gantry will stop managing this Docker host. Nothing on the host is changed."
            }
            confirmLabel="Remove"
            onConfirm={() => deleteEnvironment(row.original.id)}
          >
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Remove environment">
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
  const columns = React.useMemo(() => environmentColumns(users), [users])
  return (
    <AgentEnrollmentProvider>
      <DataTable
        data={data}
        columns={columns}
        getRowId={(r) => String(r.id)}
        emptyMessage="No environments."
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
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon data-icon="inline-start" />
          <span className="hidden lg:inline">Add environment</span>
        </Button>
      }
      title="Add environment"
      description="Connect another Docker host or a Kubernetes cluster. Gantry checks the connection before saving. Only administrators can use it until you grant access."
      submitLabel="Connect"
      action={createEnvironment}
      className={ENV_DIALOG_CLASS}
    >
      {(errors) => <EnvironmentFields errors={errors} />}
    </FormDialog>
  )
}

function EditEnvironmentDialog({ row }: { row: EnvironmentRow }) {
  return (
    <FormDialog
      trigger={
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Edit environment">
          <PencilIcon />
        </Button>
      }
      title={`Edit ${row.name}`}
      description="Gantry checks the connection before saving."
      submitLabel="Save"
      action={updateEnvironment}
      className={ENV_DIALOG_CLASS}
    >
      {(errors) => <EnvironmentFields errors={errors} initial={row} />}
    </FormDialog>
  )
}
