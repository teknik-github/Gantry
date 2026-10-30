"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  KeyRoundIcon,
  LockIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShipWheelIcon,
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
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
  type: "socket" | "tcp" | "kubernetes"
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
          {row.original.status === "up" ? `up · ${row.original.version}` : "unreachable"}
        </Badge>
      ),
    }),
    envHelper.accessor("type", {
      header: "Type",
      cell: ({ row }) =>
        row.original.type === "socket" ? (
          "Unix socket"
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
            description={
              row.original.type === "kubernetes"
                ? "Gantry will stop managing this cluster and forget its credentials. Nothing in the cluster is changed."
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
  required = true,
  accept = ".pem,.crt,.cer,.key,text/plain",
  maxBytes = PEM_MAX_BYTES,
  description,
}: {
  id: string
  name: string
  label: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  error?: string
  required?: boolean
  accept?: string
  maxBytes?: number
  description?: React.ReactNode
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
          accept={accept}
          aria-label={`${label} file`}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (!file) return
            if (file.size > maxBytes) {
              toast.error(`${file.name} is too large`)
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
        required={required}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        className="h-20 max-h-32 resize-none font-mono text-[11px] leading-tight [field-sizing:fixed]"
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  )
}

type EnvironmentDefaults = Pick<EnvironmentRow, "id" | "name" | "type" | "url" | "tls" | "kubeAuth" | "kubeInsecure" | "kubeNamespace">

/** Fields shared by the add and edit dialogs. */
function EnvironmentFields({ errors, initial }: { errors: Errors; initial?: EnvironmentDefaults }) {
  const prefix = initial ? `e${initial.id}` : "e"
  const [type, setType] = React.useState<string>(initial?.type ?? "tcp")
  const [useTls, setUseTls] = React.useState(initial?.tls ?? false)
  // Editing an environment that already has certificates keeps them unless replaced.
  const [replacing, setReplacing] = React.useState(!initial?.tls)
  const [pem, setPem] = React.useState({ ca: "", cert: "", key: "" })
  const tcp = type === "tcp"
  const kubernetes = type === "kubernetes"
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
        <Select name="type" value={type} onValueChange={setType} disabled={initial?.type === "kubernetes"}>
          <SelectTrigger id={`${prefix}-type`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {initial?.type !== "kubernetes" ? (
              <>
                <SelectItem value="tcp">TCP (Docker API over the network)</SelectItem>
                <SelectItem value="socket">Unix socket (mounted into Gantry)</SelectItem>
              </>
            ) : null}
            {/* Docker and Kubernetes environments can't be turned into each other. */}
            {!initial || initial.type === "kubernetes" ? (
              <SelectItem value="kubernetes">Kubernetes (API server)</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        {/* A disabled select submits nothing. */}
        {initial?.type === "kubernetes" ? <input type="hidden" name="type" value="kubernetes" /> : null}
      </Field>
      {kubernetes ? (
        <KubernetesFields errors={errors} initial={initial} />
      ) : (
        <>
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
      )}
    </>
  )
}

const KUBECONFIG_MAX_BYTES = 256 * 1024

/**
 * Kubernetes connection: API server + service account token (+ CA), or a
 * pasted kubeconfig. When editing, the stored connection is kept unless
 * replaced; the token and keys are never sent back to the browser.
 */
function KubernetesFields({ errors, initial }: { errors: Errors; initial?: EnvironmentDefaults }) {
  // Unique ids: Next keeps recently visited pages hidden in the DOM.
  const uid = React.useId()
  const editing = initial?.type === "kubernetes"
  const [replacing, setReplacing] = React.useState(!editing)
  const [mode, setMode] = React.useState<"token" | "kubeconfig">("token")
  const [insecure, setInsecure] = React.useState(false)
  const [ca, setCa] = React.useState("")
  const [kubeconfig, setKubeconfig] = React.useState("")

  const namespaceField = (
    <Field data-invalid={errors.kube_namespace ? true : undefined}>
      <FieldLabel htmlFor={`${uid}-ns`}>Default namespace</FieldLabel>
      <Input
        id={`${uid}-ns`}
        name="kube_namespace"
        placeholder={mode === "kubeconfig" && replacing ? "from the context" : "all namespaces"}
        defaultValue={editing && !replacing ? (initial?.kubeNamespace ?? "") : ""}
        className="font-mono text-xs"
        autoComplete="off"
        spellCheck={false}
      />
      <FieldDescription>Preselected on the list pages and for Apply. Leave empty to show all namespaces.</FieldDescription>
      <FieldError>{errors.kube_namespace?.[0]}</FieldError>
    </Field>
  )

  if (!replacing) {
    return (
      <>
        <div className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <ShipWheelIcon className="size-4 shrink-0 text-emerald-600" />
            <div className="grid min-w-0 gap-0.5">
              <span className="truncate font-mono text-xs">{initial?.url}</span>
              <span className="text-xs text-muted-foreground">
                Connected with {initial?.kubeAuth.filter((a) => a !== "CA").join(" and ") || "stored credentials"}
                {initial?.kubeInsecure ? ", TLS verification off" : ""}. Credentials are stored encrypted and never shown
                again.
              </span>
            </div>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
            Replace
          </Button>
        </div>
        {namespaceField}
      </>
    )
  }

  return (
    <>
      {editing ? <input type="hidden" name="kube_replace" value="on" /> : null}
      <input type="hidden" name="kube_mode" value={mode} />
      <Field>
        <FieldLabel>Credentials</FieldLabel>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={mode}
          onValueChange={(v) => v && setMode(v as "token" | "kubeconfig")}
          aria-label="Credentials"
        >
          <ToggleGroupItem value="token">Service account token</ToggleGroupItem>
          <ToggleGroupItem value="kubeconfig">Kubeconfig</ToggleGroupItem>
        </ToggleGroup>
      </Field>
      {/* Keyed so inputs aren't reused across modes (the token would end up in Context). */}
      {mode === "token" ? (
        <React.Fragment key="token">
          <Field data-invalid={errors.kube_server ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-server`}>API server URL</FieldLabel>
            <Input
              id={`${uid}-server`}
              name="kube_server"
              required
              placeholder="https://10.0.0.5:6443"
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <FieldError>{errors.kube_server?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.kube_token ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-token`}>Bearer token</FieldLabel>
            <Input
              id={`${uid}-token`}
              name="kube_token"
              type="password"
              required
              autoComplete="off"
              className="font-mono text-xs"
            />
            <FieldDescription>
              A service account token, e.g. from <Mono>kubectl create token gantry -n kube-system</Mono>. Gantry can do
              what the account&apos;s RBAC allows.
            </FieldDescription>
            <FieldError>{errors.kube_token?.[0]}</FieldError>
          </Field>
          <PemField
            id={`${uid}-ca`}
            name="kube_ca"
            label="CA certificate"
            placeholder="Cluster CA: -----BEGIN CERTIFICATE----- (optional)"
            value={ca}
            onChange={setCa}
            required={false}
            error={errors.kube_ca?.[0]}
            description="Leave empty if the API server's certificate is signed by a public CA."
          />
          <Field orientation="horizontal">
            <Switch id={`${uid}-insecure`} checked={insecure} onCheckedChange={setInsecure} />
            <FieldLabel htmlFor={`${uid}-insecure`}>Skip TLS verification</FieldLabel>
            {insecure ? <input type="hidden" name="kube_insecure" value="on" /> : null}
          </Field>
          {insecure ? (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 p-3 text-xs text-amber-700 dark:text-amber-400">
              <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
              The API server&apos;s certificate won&apos;t be checked, so anyone on the network path could impersonate
              the cluster and capture the token. Only use this for test clusters.
            </p>
          ) : null}
        </React.Fragment>
      ) : (
        <React.Fragment key="kubeconfig">
          <PemField
            id={`${uid}-kubeconfig`}
            name="kubeconfig"
            label="Kubeconfig"
            placeholder="apiVersion: v1&#10;kind: Config&#10;clusters: ..."
            value={kubeconfig}
            onChange={setKubeconfig}
            accept=".yaml,.yml,.conf,.config,text/plain,application/yaml"
            maxBytes={KUBECONFIG_MAX_BYTES}
            error={errors.kubeconfig?.[0]}
            description={
              <>
                Certificates must be embedded (<Mono>kubectl config view --raw --minify --flatten</Mono>). Token and
                client certificate users work; exec and auth-provider plugins don&apos;t.
              </>
            }
          />
          <Field data-invalid={errors.kube_context ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-context`}>Context</FieldLabel>
            <Input
              id={`${uid}-context`}
              name="kube_context"
              placeholder="current-context"
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <FieldError>{errors.kube_context?.[0]}</FieldError>
          </Field>
        </React.Fragment>
      )}
      {namespaceField}
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
