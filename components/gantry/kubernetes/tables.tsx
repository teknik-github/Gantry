"use client"

import * as React from "react"
import Link from "next/link"
import { PlusIcon, RotateCwIcon, ScalingIcon, ScrollTextIcon, Trash2Icon } from "lucide-react"

import {
  createNamespace,
  deleteNamespace,
  deletePod,
  deleteWorkload,
  restartWorkload,
  scaleWorkload,
} from "@/app/(app)/kubernetes/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono } from "@/components/gantry/ui"
import { useRunAction } from "@/components/gantry/use-action"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { timeAgo } from "@/lib/format"
import { MAX_REPLICAS, PROTECTED_NAMESPACES } from "@/lib/kubernetes/names"
import type {
  ConfigMapRow,
  EventRow,
  IngressRow,
  NamespaceRow,
  NodeRow,
  PodRow,
  SecretRow,
  ServiceRow,
  WorkloadRow,
} from "@/lib/kubernetes/rows"
import { cn } from "@/lib/utils"

// ------------------------------------------------------------------ helpers

/** Relative age; the server and browser clocks may differ by a second. */
export function Age({ at }: { at: string }) {
  if (!at) return <span className="text-muted-foreground">—</span>
  return (
    <time dateTime={at} title={new Date(at).toLocaleString()} className="whitespace-nowrap text-muted-foreground" suppressHydrationWarning>
      {timeAgo(at)}
    </time>
  )
}

// Pod/node phases, plus Helm release states (deployed, pending-*, uninstalling, superseded).
const GOOD = new Set(["Running", "Succeeded", "Completed", "Active", "Ready", "deployed", "superseded"])
const PENDING = new Set(["Pending", "ContainerCreating", "PodInitializing", "Terminating", "Unknown", "uninstalling"])

export function KubeStatus({ status }: { status: string }) {
  const color = GOOD.has(status)
    ? "bg-emerald-500"
    : PENDING.has(status) || status.startsWith("Init:") || status.startsWith("pending-")
      ? "bg-amber-500"
      : "bg-red-500"
  return (
    <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground">
      <span className={cn("size-2 rounded-full", color)} />
      {status}
    </Badge>
  )
}

function Tags({ items, empty = "—" }: { items: string[]; empty?: string }) {
  if (!items.length) return <span className="text-muted-foreground">{empty}</span>
  return (
    <div className="flex max-w-96 flex-wrap gap-1">
      {items.map((t) => (
        <Badge key={t} variant="secondary" className="font-mono text-[11px]">
          {t}
        </Badge>
      ))}
    </div>
  )
}

function IconButton({ label, children, ...props }: React.ComponentProps<typeof Button> & { label: string }) {
  return (
    <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={label} title={label} {...props}>
      {children}
    </Button>
  )
}

// --------------------------------------------------------------------- nodes

const nodeHelper = columnHelperFor<NodeRow>()
const nodeColumns = nodeHelper.columns([
  nodeHelper.accessor("name", {
    header: ({ column }) => <SortHeader column={column} title="Name" />,
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    enableHiding: false,
  }),
  nodeHelper.display({
    id: "status",
    header: "Status",
    cell: ({ row }) => (
      <div className="flex items-center gap-1.5">
        <KubeStatus status={row.original.ready ? "Ready" : "NotReady"} />
        {!row.original.schedulable ? <Badge variant="outline">cordoned</Badge> : null}
      </div>
    ),
  }),
  nodeHelper.display({ id: "roles", header: "Roles", cell: ({ row }) => <Tags items={row.original.roles} /> }),
  nodeHelper.accessor("version", { header: "Version", cell: ({ row }) => <Mono>{row.original.version}</Mono> }),
  nodeHelper.accessor("internalIP", { header: "Internal IP", cell: ({ row }) => <Mono>{row.original.internalIP || "—"}</Mono> }),
  nodeHelper.accessor("os", { header: "OS" }),
  nodeHelper.accessor("created", { header: "Age", cell: ({ row }) => <Age at={row.original.created} /> }),
])

export function NodesTable({ data }: { data: NodeRow[] }) {
  return <DataTable data={data} columns={nodeColumns} getRowId={(r) => r.name} emptyMessage="No nodes." />
}

// ---------------------------------------------------------------------- pods

const podHelper = columnHelperFor<PodRow>()

function podColumns(environmentId: number, canManage: boolean, showNamespace: boolean) {
  return podHelper.columns([
    podHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => (
        <Link
          href={`/kubernetes/pods/${encodeURIComponent(row.original.namespace)}/${encodeURIComponent(row.original.name)}`}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
      enableHiding: false,
    }),
    ...(showNamespace
      ? [podHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title="Namespace" /> })]
      : []),
    podHelper.accessor("status", {
      header: ({ column }) => <SortHeader column={column} title="Status" />,
      cell: ({ row }) => <KubeStatus status={row.original.status} />,
    }),
    podHelper.accessor("ready", { header: "Ready", cell: ({ row }) => <span className="tabular-nums">{row.original.ready}</span> }),
    podHelper.accessor("restarts", {
      header: ({ column }) => <SortHeader column={column} title="Restarts" />,
      cell: ({ row }) => <span className="tabular-nums">{row.original.restarts}</span>,
    }),
    podHelper.accessor("node", { header: "Node", cell: ({ row }) => row.original.node || <span className="text-muted-foreground">—</span> }),
    podHelper.accessor("created", {
      header: ({ column }) => <SortHeader column={column} title="Age" />,
      cell: ({ row }) => <Age at={row.original.created} />,
    }),
    podHelper.display({
      id: "actions",
      cell: ({ row }) => {
        const p = row.original
        return (
          <div className="flex justify-end gap-1">
            <IconButton label="Logs" asChild>
              <Link href={`/kubernetes/pods/${encodeURIComponent(p.namespace)}/${encodeURIComponent(p.name)}`}>
                <ScrollTextIcon />
              </Link>
            </IconButton>
            {canManage ? (
              <ConfirmAction
                title={`Delete pod ${p.name}?`}
                description={`Pod ${p.namespace}/${p.name} is stopped and removed. If a controller (Deployment, StatefulSet, ...) owns it, a replacement is started.`}
                confirmLabel="Delete"
                onConfirm={() => deletePod({ environmentId, namespace: p.namespace, name: p.name })}
              >
                <IconButton label="Delete pod">
                  <Trash2Icon />
                </IconButton>
              </ConfirmAction>
            ) : null}
          </div>
        )
      },
      enableHiding: false,
    }),
  ])
}

export function PodsTable({
  data,
  environmentId,
  canManage,
  showNamespace,
}: {
  data: PodRow[]
  environmentId: number
  canManage: boolean
  showNamespace: boolean
}) {
  const columns = React.useMemo(() => podColumns(environmentId, canManage, showNamespace), [environmentId, canManage, showNamespace])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.status} ${r.node}`}
      searchPlaceholder="Search pods…"
      emptyMessage="No pods."
      pageSize={20}
    />
  )
}

// ----------------------------------------------------------------- workloads

function ScaleDialog({ row, environmentId }: { row: WorkloadRow; environmentId: number }) {
  const uid = React.useId()
  const [open, setOpen] = React.useState(false)
  const [value, setValue] = React.useState(String(row.desired))
  const [pending, run] = useRunAction()
  const n = Number(value)
  const valid = value.trim() !== "" && Number.isInteger(n) && n >= 0 && n <= MAX_REPLICAS

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return
        setOpen(o)
        if (o) setValue(String(row.desired))
      }}
    >
      <DialogTrigger asChild>
        <IconButton label="Scale">
          <ScalingIcon />
        </IconButton>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Scale {row.name}</DialogTitle>
          <DialogDescription>
            {row.kind} {row.namespace}/{row.name} currently wants {row.desired} replica(s).
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-5"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!valid) return
            const ok = await run(() =>
              scaleWorkload({ environmentId, kind: row.kind, namespace: row.namespace, name: row.name }, n)
            )
            if (ok) setOpen(false)
          }}
        >
          <Field data-invalid={!valid ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-replicas`}>Replicas</FieldLabel>
            <Input
              id={`${uid}-replicas`}
              type="number"
              min={0}
              max={MAX_REPLICAS}
              step={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
            />
            {n === 0 && valid ? <FieldDescription>0 stops all pods but keeps the {row.kind}.</FieldDescription> : null}
            {!valid ? <FieldError>Enter a whole number from 0 to {MAX_REPLICAS}</FieldError> : null}
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !valid}>
              {pending ? "Working…" : "Scale"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const workloadHelper = columnHelperFor<WorkloadRow>()

function workloadColumns(environmentId: number, can: { operate: boolean; manage: boolean }, showNamespace: boolean) {
  return workloadHelper.columns([
    workloadHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    workloadHelper.accessor("kind", {
      header: ({ column }) => <SortHeader column={column} title="Kind" />,
      cell: ({ row }) => <Badge variant="outline">{row.original.kind}</Badge>,
    }),
    ...(showNamespace
      ? [workloadHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title="Namespace" /> })]
      : []),
    workloadHelper.display({
      id: "ready",
      header: "Ready",
      cell: ({ row }) => {
        const { ready, desired } = row.original
        return (
          <span
            className={cn("tabular-nums", ready < desired && "text-amber-600")}
            data-testid={`workload-ready-${row.original.name}`}
          >
            {ready}/{desired}
          </span>
        )
      },
    }),
    workloadHelper.accessor("upToDate", {
      header: "Up to date",
      cell: ({ row }) => <span className="tabular-nums">{row.original.upToDate}</span>,
    }),
    workloadHelper.display({ id: "images", header: "Images", cell: ({ row }) => <Tags items={row.original.images} /> }),
    workloadHelper.accessor("created", {
      header: ({ column }) => <SortHeader column={column} title="Age" />,
      cell: ({ row }) => <Age at={row.original.created} />,
    }),
    workloadHelper.display({
      id: "actions",
      cell: ({ row }) => {
        const w = row.original
        // Restart is an operator action (like restarting a container); scale and delete need manager.
        if (!can.operate) return null
        const ref = { environmentId, kind: w.kind, namespace: w.namespace, name: w.name }
        return (
          <div className="flex justify-end gap-1">
            {can.manage && w.kind !== "DaemonSet" ? <ScaleDialog row={w} environmentId={environmentId} /> : null}
            <ConfirmAction
              title={`Restart ${w.name}?`}
              description={`Like kubectl rollout restart: the pods of ${w.kind} ${w.namespace}/${w.name} are replaced one by one.`}
              confirmLabel="Restart"
              destructive={false}
              onConfirm={() => restartWorkload(ref)}
            >
              <IconButton label="Restart">
                <RotateCwIcon />
              </IconButton>
            </ConfirmAction>
            {can.manage ? (
              <ConfirmAction
                title={`Delete ${w.kind} ${w.name}?`}
                description={`${w.kind} ${w.namespace}/${w.name} and its pods are deleted. This can't be undone.`}
                confirmLabel="Delete"
                onConfirm={() => deleteWorkload(ref)}
              >
                <IconButton label="Delete">
                  <Trash2Icon />
                </IconButton>
              </ConfirmAction>
            ) : null}
          </div>
        )
      },
      enableHiding: false,
    }),
  ])
}

export function WorkloadsTable({
  data,
  environmentId,
  canOperate,
  canManage,
  showNamespace,
}: {
  data: WorkloadRow[]
  environmentId: number
  canOperate: boolean
  canManage: boolean
  showNamespace: boolean
}) {
  const columns = React.useMemo(
    () => workloadColumns(environmentId, { operate: canOperate, manage: canManage }, showNamespace),
    [environmentId, canOperate, canManage, showNamespace]
  )
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.kind} ${r.namespace} ${r.images.join(" ")}`}
      searchPlaceholder="Search workloads…"
      emptyMessage="No deployments, stateful sets or daemon sets."
      pageSize={20}
    />
  )
}

// ------------------------------------------------------- services, ingresses

const serviceHelper = columnHelperFor<ServiceRow>()

function serviceColumns(showNamespace: boolean) {
  return serviceHelper.columns([
    serviceHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    ...(showNamespace
      ? [serviceHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title="Namespace" /> })]
      : []),
    serviceHelper.accessor("type", {
      header: ({ column }) => <SortHeader column={column} title="Type" />,
      cell: ({ row }) => <Badge variant="outline">{row.original.type}</Badge>,
    }),
    serviceHelper.accessor("clusterIP", { header: "Cluster IP", cell: ({ row }) => <Mono>{row.original.clusterIP || "—"}</Mono> }),
    serviceHelper.display({ id: "ports", header: "Ports", cell: ({ row }) => <Tags items={row.original.ports} /> }),
    serviceHelper.display({ id: "external", header: "External", cell: ({ row }) => <Tags items={row.original.externalIPs} /> }),
    serviceHelper.accessor("created", { header: "Age", cell: ({ row }) => <Age at={row.original.created} /> }),
  ])
}

export function ServicesTable({ data, showNamespace }: { data: ServiceRow[]; showNamespace: boolean }) {
  const columns = React.useMemo(() => serviceColumns(showNamespace), [showNamespace])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.type} ${r.clusterIP} ${r.ports.join(" ")}`}
      searchPlaceholder="Search services…"
      emptyMessage="No services."
      pageSize={20}
    />
  )
}

const ingressHelper = columnHelperFor<IngressRow>()

function ingressColumns(showNamespace: boolean) {
  return ingressHelper.columns([
    ingressHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    ...(showNamespace
      ? [ingressHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title="Namespace" /> })]
      : []),
    ingressHelper.accessor("className", { header: "Class", cell: ({ row }) => row.original.className || "—" }),
    ingressHelper.display({ id: "hosts", header: "Hosts", cell: ({ row }) => <Tags items={row.original.hosts} /> }),
    ingressHelper.display({ id: "address", header: "Address", cell: ({ row }) => <Tags items={row.original.address} /> }),
    ingressHelper.accessor("created", { header: "Age", cell: ({ row }) => <Age at={row.original.created} /> }),
  ])
}

export function IngressesTable({ data, showNamespace }: { data: IngressRow[]; showNamespace: boolean }) {
  const columns = React.useMemo(() => ingressColumns(showNamespace), [showNamespace])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.hosts.join(" ")}`}
      searchPlaceholder="Search ingresses…"
      emptyMessage="No ingresses."
    />
  )
}

// ---------------------------------------------------------------- namespaces

const namespaceHelper = columnHelperFor<NamespaceRow>()

function namespaceColumns(environmentId: number, canManage: boolean) {
  return namespaceHelper.columns([
    namespaceHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    namespaceHelper.accessor("status", { header: "Status", cell: ({ row }) => <KubeStatus status={row.original.status} /> }),
    namespaceHelper.accessor("created", {
      header: ({ column }) => <SortHeader column={column} title="Age" />,
      cell: ({ row }) => <Age at={row.original.created} />,
    }),
    namespaceHelper.display({
      id: "actions",
      cell: ({ row }) =>
        canManage && !PROTECTED_NAMESPACES.has(row.original.name) && row.original.status !== "Terminating" ? (
          <div className="flex justify-end">
            <ConfirmAction
              title={`Delete namespace ${row.original.name}?`}
              description="Everything in the namespace (workloads, pods, services, config, secrets, volume claims) is deleted. This can't be undone."
              confirmLabel="Delete"
              onConfirm={() => deleteNamespace(environmentId, row.original.name)}
            >
              <IconButton label="Delete namespace">
                <Trash2Icon />
              </IconButton>
            </ConfirmAction>
          </div>
        ) : null,
      enableHiding: false,
    }),
  ])
}

export function NamespacesTable({ data, environmentId, canManage }: { data: NamespaceRow[]; environmentId: number; canManage: boolean }) {
  const columns = React.useMemo(() => namespaceColumns(environmentId, canManage), [environmentId, canManage])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.name}
      searchText={(r) => r.name}
      searchPlaceholder="Search namespaces…"
      emptyMessage="No namespaces."
      pageSize={20}
      toolbar={
        canManage ? (
          <FormDialog
            trigger={
              <Button size="sm">
                <PlusIcon data-icon="inline-start" />
                <span className="hidden lg:inline">Create namespace</span>
              </Button>
            }
            title="Create namespace"
            submitLabel="Create"
            action={createNamespace}
          >
            {(errors) => <NamespaceNameField environmentId={environmentId} error={errors.name?.[0]} />}
          </FormDialog>
        ) : null
      }
    />
  )
}

function NamespaceNameField({ environmentId, error }: { environmentId: number; error?: string }) {
  const uid = React.useId()
  return (
    <Field data-invalid={error ? true : undefined}>
      <input type="hidden" name="environment" value={environmentId} />
      <FieldLabel htmlFor={`${uid}-ns-name`}>Name</FieldLabel>
      <Input id={`${uid}-ns-name`} name="name" placeholder="my-app" required autoFocus autoComplete="off" spellCheck={false} />
      <FieldDescription>Lowercase letters, digits and &apos;-&apos;, at most 63 characters.</FieldDescription>
      <FieldError>{error}</FieldError>
    </Field>
  )
}

// ------------------------------------------------------ configmaps, secrets

const cmHelper = columnHelperFor<ConfigMapRow>()

function configMapColumns(showNamespace: boolean) {
  return cmHelper.columns([
    cmHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    ...(showNamespace ? [cmHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title="Namespace" /> })] : []),
    cmHelper.display({ id: "keys", header: "Keys", cell: ({ row }) => <Tags items={row.original.keys} empty="no keys" /> }),
    cmHelper.accessor("created", { header: "Age", cell: ({ row }) => <Age at={row.original.created} /> }),
  ])
}

export function ConfigMapsTable({ data, showNamespace }: { data: ConfigMapRow[]; showNamespace: boolean }) {
  const columns = React.useMemo(() => configMapColumns(showNamespace), [showNamespace])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.keys.join(" ")}`}
      searchPlaceholder="Search config maps…"
      emptyMessage="No config maps."
    />
  )
}

const secretHelper = columnHelperFor<SecretRow>()

function secretColumns(showNamespace: boolean) {
  return secretHelper.columns([
    secretHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    ...(showNamespace
      ? [secretHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title="Namespace" /> })]
      : []),
    secretHelper.accessor("type", { header: "Type", cell: ({ row }) => <Mono>{row.original.type}</Mono> }),
    secretHelper.display({ id: "keys", header: "Keys", cell: ({ row }) => <Tags items={row.original.keys} empty="no keys" /> }),
    secretHelper.accessor("created", { header: "Age", cell: ({ row }) => <Age at={row.original.created} /> }),
  ])
}

export function SecretsTable({ data, showNamespace }: { data: SecretRow[]; showNamespace: boolean }) {
  const columns = React.useMemo(() => secretColumns(showNamespace), [showNamespace])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.type} ${r.keys.join(" ")}`}
      searchPlaceholder="Search secrets…"
      emptyMessage="No secrets."
    />
  )
}

// -------------------------------------------------------------------- events

const eventHelper = columnHelperFor<EventRow>()

function eventColumns(showNamespace: boolean) {
  return eventHelper.columns([
    eventHelper.accessor("lastSeen", {
      header: ({ column }) => <SortHeader column={column} title="Last seen" />,
      cell: ({ row }) => <Age at={row.original.lastSeen} />,
    }),
    ...(showNamespace
      ? [eventHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title="Namespace" /> })]
      : []),
    eventHelper.accessor("type", {
      header: "Type",
      cell: ({ row }) => (
        <Badge variant="outline" className={cn(row.original.type === "Warning" && "text-amber-600")}>
          {row.original.type}
        </Badge>
      ),
    }),
    eventHelper.accessor("reason", { header: ({ column }) => <SortHeader column={column} title="Reason" /> }),
    eventHelper.accessor("object", { header: "Object", cell: ({ row }) => <Mono>{row.original.object}</Mono> }),
    eventHelper.accessor("message", {
      header: "Message",
      cell: ({ row }) => <span className="block max-w-xl text-xs break-words whitespace-normal">{row.original.message}</span>,
    }),
    eventHelper.accessor("count", {
      header: "Count",
      cell: ({ row }) => <span className="tabular-nums">{row.original.count}</span>,
    }),
  ])
}

export function EventsTable({ data, showNamespace }: { data: EventRow[]; showNamespace: boolean }) {
  const columns = React.useMemo(() => eventColumns(showNamespace), [showNamespace])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.namespace} ${r.reason} ${r.object} ${r.message}`}
      searchPlaceholder="Search events…"
      emptyMessage="No warnings."
      pageSize={50}
    />
  )
}
