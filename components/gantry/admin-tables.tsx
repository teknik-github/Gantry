"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  KeyRoundIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UploadIcon,
  UsersIcon,
} from "lucide-react"

import {
  createEnvironment,
  deleteEnvironment,
  setEnvironmentAccess,
  updateEnvironment,
} from "@/app/(app)/environments/actions"
import { createUser, deleteUser, resetPassword, setUserAccess, setUserRole } from "@/app/(app)/users/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono } from "@/components/gantry/ui"
import { useRunAction } from "@/components/gantry/use-action"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { ActionState } from "@/lib/validation"
import { cn } from "@/lib/utils"

type Errors = Record<string, string[] | undefined>

// ------------------------------------------------------------- Access dialogs

type AccessOption = { id: number; label: string }

/**
 * Checkbox list bound to a Server Action: submits `id` plus one `fieldName`
 * value per checked option.
 */
function AccessDialog({
  trigger,
  title,
  description,
  action,
  id,
  fieldName,
  options,
  selected,
  emptyMessage,
}: {
  trigger: React.ReactNode
  title: string
  description: React.ReactNode
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>
  id: number
  fieldName: string
  options: AccessOption[]
  selected: number[]
  emptyMessage: string
}) {
  return (
    <FormDialog trigger={trigger} title={title} description={description} submitLabel="Save" action={action}>
      {() => (
        <>
          <input type="hidden" name="id" value={id} />
          <AccessChecklist
            idPrefix={`${fieldName}-${id}`}
            fieldName={fieldName}
            options={options}
            initial={selected}
            emptyMessage={emptyMessage}
          />
        </>
      )}
    </FormDialog>
  )
}

function AccessChecklist({
  idPrefix,
  fieldName,
  options,
  initial,
  emptyMessage,
}: {
  idPrefix: string
  fieldName: string
  options: AccessOption[]
  initial: number[]
  emptyMessage: string
}) {
  const [checked, setChecked] = React.useState(() => new Set(initial))
  if (options.length === 0) return <p className="text-sm text-muted-foreground">{emptyMessage}</p>
  return (
    <div className="flex max-h-72 flex-col gap-3 overflow-y-auto" role="group" aria-label="Access">
      {options.map((o) => (
        <Field key={o.id} orientation="horizontal">
          <Checkbox
            id={`${idPrefix}-${o.id}`}
            checked={checked.has(o.id)}
            onCheckedChange={(value) =>
              setChecked((prev) => {
                const next = new Set(prev)
                if (value === true) next.add(o.id)
                else next.delete(o.id)
                return next
              })
            }
          />
          <FieldLabel htmlFor={`${idPrefix}-${o.id}`} className="font-normal">
            {o.label}
          </FieldLabel>
          {checked.has(o.id) ? <input type="hidden" name={fieldName} value={o.id} /> : null}
        </Field>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- Environments

export type EnvironmentRow = {
  id: number
  name: string
  type: "socket" | "tcp"
  url: string
  /** Whether TLS certificates are stored. The PEM material itself never reaches the browser. */
  tls: boolean
  status: "up" | "down"
  version: string | null
  error: string | null
  current: boolean
  /** Standard users granted access (administrators can always use it). */
  access: { id: number; username: string }[]
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
      cell: ({ row }) => (
        <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground" title={row.original.error ?? undefined}>
          <span className={cn("size-2 rounded-full", row.original.status === "up" ? "bg-emerald-500" : "bg-red-500")} />
          {row.original.status === "up" ? `up · Docker ${row.original.version}` : "unreachable"}
        </Badge>
      ),
    }),
    envHelper.accessor("type", {
      header: "Type",
      cell: ({ row }) =>
        row.original.type === "socket" ? (
          "Unix socket"
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
      cell: ({ row }) => <Mono>{row.original.url}</Mono>,
    }),
    envHelper.display({
      id: "access",
      header: "Access",
      cell: ({ row }) =>
        row.original.access.length ? (
          <div className="flex max-w-72 flex-wrap gap-1" data-testid={`env-access-${row.original.name}`}>
            {row.original.access.map((u) => (
              <Badge key={u.id} variant="secondary">
                {u.username}
              </Badge>
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
            description="Standard users who can see and use this environment. Administrators always can."
            action={setEnvironmentAccess}
            id={row.original.id}
            fieldName="user"
            options={users.map((u) => ({ id: u.id, label: u.username }))}
            selected={row.original.access.map((u) => u.id)}
            emptyMessage="There are no standard users yet."
          />
          <EditEnvironmentDialog row={row.original} />
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
}

export function EnvironmentsTable({ data, users }: { data: EnvironmentRow[]; users: UserOption[] }) {
  const columns = React.useMemo(() => environmentColumns(users), [users])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => String(r.id)}
      emptyMessage="No environments."
      toolbar={<AddEnvironmentDialog />}
    />
  )
}

const PEM_MAX_BYTES = 64 * 1024

function PemField({
  id,
  name,
  label,
  placeholder,
  value,
  onChange,
  error,
}: {
  id: string
  name: string
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  error?: string
}) {
  const fileRef = React.useRef<HTMLInputElement>(null)
  return (
    <Field data-invalid={error ? true : undefined}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => fileRef.current?.click()}>
          <UploadIcon data-icon="inline-start" />
          Load file
        </Button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept=".pem,.crt,.cer,.key,text/plain"
          aria-label={`${label} file`}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (!file) return
            if (file.size > PEM_MAX_BYTES) {
              toast.error(`${file.name} is too large for a PEM file`)
              return
            }
            onChange(await file.text())
          }}
        />
      </div>
      <Textarea
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        className="h-20 max-h-32 resize-none font-mono text-[11px] leading-tight [field-sizing:fixed]"
      />
      <FieldError>{error}</FieldError>
    </Field>
  )
}

type EnvironmentDefaults = Pick<EnvironmentRow, "id" | "name" | "type" | "url" | "tls">

/** Fields shared by the add and edit dialogs. */
function EnvironmentFields({ errors, initial }: { errors: Errors; initial?: EnvironmentDefaults }) {
  const prefix = initial ? `e${initial.id}` : "e"
  const [type, setType] = React.useState<string>(initial?.type ?? "tcp")
  const [useTls, setUseTls] = React.useState(initial?.tls ?? false)
  // Editing an environment that already has certificates keeps them unless replaced.
  const [replacing, setReplacing] = React.useState(!initial?.tls)
  const [pem, setPem] = React.useState({ ca: "", cert: "", key: "" })
  const tcp = type === "tcp"
  const showPem = tcp && useTls && replacing

  return (
    <>
      {initial ? <input type="hidden" name="id" value={initial.id} /> : null}
      <Field data-invalid={errors.name ? true : undefined}>
        <FieldLabel htmlFor={`${prefix}-name`}>Name</FieldLabel>
        <Input
          id={`${prefix}-name`}
          name="name"
          placeholder="production"
          defaultValue={initial?.name}
          required
          autoFocus
        />
        <FieldError>{errors.name?.[0]}</FieldError>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${prefix}-type`}>Connection</FieldLabel>
        <Select name="type" value={type} onValueChange={setType}>
          <SelectTrigger id={`${prefix}-type`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tcp">TCP (Docker API over the network)</SelectItem>
            <SelectItem value="socket">Unix socket (mounted into Gantry)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field data-invalid={errors.url ? true : undefined}>
        <FieldLabel htmlFor={`${prefix}-url`}>{tcp ? "Host and port" : "Socket path"}</FieldLabel>
        <Input
          id={`${prefix}-url`}
          name="url"
          required
          defaultValue={initial?.url}
          className="font-mono text-xs"
          placeholder={tcp ? (useTls ? "10.0.0.5:2376" : "10.0.0.5:2375") : "/var/run/docker.sock"}
        />
        {tcp && !useTls ? (
          <FieldDescription>Unencrypted Docker API. Only use it over a private network or VPN.</FieldDescription>
        ) : null}
        <FieldError>{errors.url?.[0]}</FieldError>
      </Field>
      {tcp ? (
        <Field orientation="horizontal">
          <Switch id={`${prefix}-tls`} checked={useTls} onCheckedChange={setUseTls} />
          <FieldLabel htmlFor={`${prefix}-tls`}>Use TLS</FieldLabel>
          {useTls ? <input type="hidden" name="tls" value="on" /> : null}
        </Field>
      ) : null}
      {tcp && useTls && !replacing ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-4 text-emerald-600" />
            <div className="grid gap-0.5">
              <span className="font-medium">TLS configured</span>
              <span className="text-xs text-muted-foreground">
                Certificates are stored encrypted; the private key is never shown again.
              </span>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
            Replace
          </Button>
        </div>
      ) : null}
      {tcp && initial?.tls && !useTls ? (
        <FieldDescription>The stored TLS certificates will be removed when you save.</FieldDescription>
      ) : null}
      {showPem ? (
        <>
          <input type="hidden" name="tls_replace" value="on" />
          <FieldDescription>
            Mutual TLS as with <Mono>docker --tlsverify</Mono>: the daemon is verified against the CA and Gantry
            authenticates with the client certificate. Paste PEM text or load the files.
          </FieldDescription>
          <PemField
            id={`${prefix}-tls-ca`}
            name="tls_ca"
            label="CA certificate"
            placeholder="ca.pem: -----BEGIN CERTIFICATE-----"
            value={pem.ca}
            onChange={(ca) => setPem((p) => ({ ...p, ca }))}
            error={errors.tls_ca?.[0]}
          />
          <PemField
            id={`${prefix}-tls-cert`}
            name="tls_cert"
            label="Client certificate"
            placeholder="cert.pem: -----BEGIN CERTIFICATE-----"
            value={pem.cert}
            onChange={(cert) => setPem((p) => ({ ...p, cert }))}
            error={errors.tls_cert?.[0]}
          />
          <PemField
            id={`${prefix}-tls-key`}
            name="tls_key"
            label="Client key"
            placeholder="key.pem: -----BEGIN PRIVATE KEY-----"
            value={pem.key}
            onChange={(key) => setPem((p) => ({ ...p, key }))}
            error={errors.tls_key?.[0]}
          />
        </>
      ) : null}
    </>
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
      description="Connect another Docker host. Gantry checks the connection before saving. Only administrators can use it until you grant access."
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

// ----------------------------------------------------------------------- Users

export type UserRow = {
  id: number
  username: string
  role: "admin" | "user"
  createdLabel: string
  self: boolean
  /** Environments a standard user was granted (ignored for administrators). */
  environmentIds: number[]
}

type EnvironmentOption = { id: number; name: string }

const userHelper = columnHelperFor<UserRow>()

function userColumns(environments: EnvironmentOption[]) {
  const names = new Map(environments.map((e) => [e.id, e.name]))
  return userHelper.columns([
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
    userHelper.display({
      id: "environments",
      header: "Environments",
      cell: ({ row }) => {
        const testId = `user-envs-${row.original.username}`
        if (row.original.role === "admin") {
          return (
            <span className="text-muted-foreground" data-testid={testId}>
              All
            </span>
          )
        }
        const granted = row.original.environmentIds.map((id) => names.get(id)).filter(Boolean)
        return granted.length ? (
          <div className="flex max-w-72 flex-wrap gap-1" data-testid={testId}>
            {granted.map((name) => (
              <Badge key={name} variant="secondary">
                {name}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground" data-testid={testId}>
            None
          </span>
        )
      },
    }),
    userHelper.accessor("createdLabel", {
      header: "Created",
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
                  aria-label={`Environment access for ${row.original.username}`}
                >
                  <ServerIcon />
                </Button>
              }
              title={`Environments for ${row.original.username}`}
              description="Which Docker environments this user can see and use."
              action={setUserAccess}
              id={row.original.id}
              fieldName="env"
              options={environments.map((e) => ({ id: e.id, label: e.name }))}
              selected={row.original.environmentIds}
              emptyMessage="There are no environments yet."
            />
          ) : null}
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
}

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

export function UsersTable({ data, environments }: { data: UserRow[]; environments: EnvironmentOption[] }) {
  const columns = React.useMemo(() => userColumns(environments), [environments])
  return (
    <DataTable
      data={data}
      columns={columns}
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
          description="New standard users can't use any environment until you give them access."
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
