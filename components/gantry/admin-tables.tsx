"use client"

import * as React from "react"
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { createEnvironment, deleteEnvironment } from "@/app/(app)/environments/actions"
import { createUser, deleteUser, resetPassword, setUserRole } from "@/app/(app)/users/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono } from "@/components/gantry/ui"
import { useRunAction } from "@/components/gantry/use-action"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

// ---------------------------------------------------------------- Environments

export type EnvironmentRow = {
  id: number
  name: string
  type: "socket" | "tcp"
  url: string
  status: "up" | "down"
  version: string | null
  error: string | null
  current: boolean
}

const envHelper = columnHelperFor<EnvironmentRow>()

const envColumns = envHelper.columns([
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
    cell: ({ row }) => (
      <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground" title={row.original.error ?? undefined}>
        <span className={cn("size-2 rounded-full", row.original.status === "up" ? "bg-emerald-500" : "bg-red-500")} />
        {row.original.status === "up" ? `up · Docker ${row.original.version}` : "unreachable"}
      </Badge>
    ),
  }),
  envHelper.accessor("type", {
    header: "Type",
    cell: ({ row }) => (row.original.type === "socket" ? "Unix socket" : "TCP"),
  }),
  envHelper.accessor("url", {
    header: "Address",
    cell: ({ row }) => <Mono>{row.original.url}</Mono>,
  }),
  envHelper.display({
    id: "actions",
    cell: ({ row }) => (
      <div className="flex justify-end">
        <ConfirmAction
          title={`Remove environment ${row.original.name}?`}
          description="Gantry will stop managing this Docker host. Nothing on the host is changed."
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

export function EnvironmentsTable({ data }: { data: EnvironmentRow[] }) {
  return (
    <DataTable
      data={data}
      columns={envColumns}
      getRowId={(r) => String(r.id)}
      emptyMessage="No environments."
      toolbar={<AddEnvironmentDialog />}
    />
  )
}

function AddEnvironmentDialog() {
  const [type, setType] = React.useState("tcp")
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon data-icon="inline-start" />
          <span className="hidden lg:inline">Add environment</span>
        </Button>
      }
      title="Add environment"
      description="Connect another Docker host. Gantry checks the connection before saving."
      submitLabel="Connect"
      action={createEnvironment}
    >
      {(errors) => (
        <>
          <Field data-invalid={errors.name ? true : undefined}>
            <FieldLabel htmlFor="e-name">Name</FieldLabel>
            <Input id="e-name" name="name" placeholder="production" required autoFocus />
            <FieldError>{errors.name?.[0]}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="e-type">Connection</FieldLabel>
            <Select name="type" value={type} onValueChange={setType}>
              <SelectTrigger id="e-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tcp">TCP (Docker API over the network)</SelectItem>
                <SelectItem value="socket">Unix socket (mounted into Gantry)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field data-invalid={errors.url ? true : undefined}>
            <FieldLabel htmlFor="e-url">{type === "tcp" ? "Host and port" : "Socket path"}</FieldLabel>
            <Input
              id="e-url"
              name="url"
              required
              className="font-mono text-xs"
              placeholder={type === "tcp" ? "10.0.0.5:2375" : "/var/run/docker.sock"}
            />
            {type === "tcp" ? (
              <FieldDescription>
                Unencrypted Docker API. Only use it over a private network or VPN.
              </FieldDescription>
            ) : null}
            <FieldError>{errors.url?.[0]}</FieldError>
          </Field>
        </>
      )}
    </FormDialog>
  )
}

// ----------------------------------------------------------------------- Users

export type UserRow = {
  id: number
  username: string
  role: "admin" | "user"
  createdLabel: string
  self: boolean
}

const userHelper = columnHelperFor<UserRow>()

const userColumns = userHelper.columns([
  userHelper.accessor("username", {
    header: ({ column }) => <SortHeader column={column} title="Username" />,
    cell: ({ row }) => (
      <div className="flex items-center gap-2 font-medium">
        {row.original.username}
        {row.original.self ? <Badge variant="secondary">you</Badge> : null}
      </div>
    ),
    enableHiding: false,
  }),
  userHelper.accessor("role", {
    header: ({ column }) => <SortHeader column={column} title="Role" />,
    cell: ({ row }) => <RoleSelect row={row.original} />,
  }),
  userHelper.accessor("createdLabel", {
    header: "Created",
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdLabel}</span>,
  }),
  userHelper.display({
    id: "actions",
    cell: ({ row }) => (
      <div className="flex justify-end gap-1">
        <ResetPasswordDialog row={row.original} />
        {!row.original.self ? (
          <ConfirmAction
            title={`Delete user ${row.original.username}?`}
            description="They will be signed out and can no longer log in."
            confirmLabel="Delete"
            onConfirm={() => deleteUser(row.original.id)}
          >
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Delete user">
              <Trash2Icon />
            </Button>
          </ConfirmAction>
        ) : null}
      </div>
    ),
    enableHiding: false,
  }),
])

function RoleSelect({ row }: { row: UserRow }) {
  const [pending, run] = useRunAction()
  return (
    <Select
      value={row.role}
      disabled={pending}
      onValueChange={(role) => run(() => setUserRole(row.id, role as UserRow["role"]))}
    >
      <SelectTrigger size="sm" className="w-36" aria-label="Role">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="admin">Administrator</SelectItem>
        <SelectItem value="user">Standard user</SelectItem>
      </SelectContent>
    </Select>
  )
}

function ResetPasswordDialog({ row }: { row: UserRow }) {
  return (
    <FormDialog
      trigger={
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Reset password">
          <KeyRoundIcon />
        </Button>
      }
      title={`Set password for ${row.username}`}
      submitLabel="Set password"
      action={resetPassword}
    >
      {(errors) => (
        <Field data-invalid={errors.password ? true : undefined}>
          <input type="hidden" name="id" value={row.id} />
          <FieldLabel htmlFor={`pw-${row.id}`}>New password</FieldLabel>
          <Input id={`pw-${row.id}`} name="password" type="password" autoComplete="new-password" required autoFocus />
          <FieldError>{errors.password?.[0]}</FieldError>
        </Field>
      )}
    </FormDialog>
  )
}

export function UsersTable({ data }: { data: UserRow[] }) {
  return (
    <DataTable
      data={data}
      columns={userColumns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => r.username}
      searchPlaceholder="Search users…"
      emptyMessage="No users."
      toolbar={
        <FormDialog
          trigger={
            <Button size="sm">
              <PlusIcon data-icon="inline-start" />
              <span className="hidden lg:inline">Add user</span>
            </Button>
          }
          title="Add user"
          submitLabel="Create"
          action={createUser}
        >
          {(errors) => (
            <>
              <Field data-invalid={errors.username ? true : undefined}>
                <FieldLabel htmlFor="u-username">Username</FieldLabel>
                <Input id="u-username" name="username" autoComplete="off" required autoFocus />
                <FieldError>{errors.username?.[0]}</FieldError>
              </Field>
              <Field data-invalid={errors.password ? true : undefined}>
                <FieldLabel htmlFor="u-password">Password</FieldLabel>
                <Input id="u-password" name="password" type="password" autoComplete="new-password" required />
                <FieldError>{errors.password?.[0]}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="u-role">Role</FieldLabel>
                <Select name="role" defaultValue="user">
                  <SelectTrigger id="u-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">Standard user</SelectItem>
                    <SelectItem value="admin">Administrator</SelectItem>
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

// -------------------------------------------------------------------- Activity

export type ActivityRow = {
  id: number
  username: string
  action: string
  target: string
  at: string
  atLabel: string
}

const actHelper = columnHelperFor<ActivityRow>()

const activityColumns = actHelper.columns([
  actHelper.accessor("at", {
    header: ({ column }) => <SortHeader column={column} title="Time" />,
    cell: ({ row }) => <span className="whitespace-nowrap text-muted-foreground">{row.original.atLabel}</span>,
  }),
  actHelper.accessor("username", {
    header: ({ column }) => <SortHeader column={column} title="User" />,
    cell: ({ row }) => <span className="font-medium">{row.original.username}</span>,
  }),
  actHelper.accessor("action", {
    header: ({ column }) => <SortHeader column={column} title="Action" />,
    cell: ({ row }) => (
      <Badge variant="outline" className={cn(row.original.action.endsWith("failed") && "text-destructive")}>
        {row.original.action}
      </Badge>
    ),
  }),
  actHelper.accessor("target", {
    header: "Target",
    cell: ({ row }) => <Mono className="block max-w-96 truncate">{row.original.target}</Mono>,
  }),
])

export function ActivityTable({ data }: { data: ActivityRow[] }) {
  return (
    <DataTable
      data={data}
      columns={activityColumns}
      getRowId={(r) => String(r.id)}
      searchText={(r) => `${r.username} ${r.action} ${r.target}`}
      searchPlaceholder="Filter activity…"
      emptyMessage="No activity yet."
      pageSize={50}
    />
  )
}
