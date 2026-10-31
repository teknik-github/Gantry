"use client"

import * as React from "react"
import Link from "next/link"
import { FileCodeIcon, PlusIcon, RotateCwIcon, ScalingIcon, ScrollTextIcon, Trash2Icon } from "lucide-react"

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
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import { editHref } from "@/lib/kubernetes/edit"
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
  const { timeAgo } = useI18n()
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

/** Link to the object's "Edit YAML" page (manager role; Secrets: administrators). */
export function EditYamlLink({ kind, namespace, name }: { kind: string; namespace: string; name: string }) {
  const { t } = useI18n()
  const href = editHref(kind, namespace, name)
  if (!href) return null
  return (
    <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" asChild>
      <Link href={href} aria-label={t.nav.pages.editYaml} title={t.nav.pages.editYaml}>
        <FileCodeIcon />
      </Link>
    </Button>
  )
}

function editColumn<T extends { kind?: string; namespace: string; name: string }>(
  helper: ReturnType<typeof columnHelperFor<T>>,
  kind: string
) {
  return helper.display({
    id: "actions",
    cell: ({ row }) => (
      <div className="flex justify-end">
        <EditYamlLink kind={row.original.kind ?? kind} namespace={row.original.namespace} name={row.original.name} />
      </div>
    ),
    enableHiding: false,
  })
}

// --------------------------------------------------------------------- nodes

const nodeHelper = columnHelperFor<NodeRow>()

function nodeColumns({ t }: I18n) {
  const k = t.kubernetes
  return nodeHelper.columns([
    nodeHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    nodeHelper.display({
      id: "status",
      header: t.common.fields.status,
      cell: ({ row }) => (
        <div className="flex items-center gap-1.5">
          <KubeStatus status={row.original.ready ? "Ready" : "NotReady"} />
          {!row.original.schedulable ? <Badge variant="outline">cordoned</Badge> : null}
        </div>
      ),
    }),
    nodeHelper.display({ id: "roles", header: k.nodes.roles, cell: ({ row }) => <Tags items={row.original.roles} /> }),
    nodeHelper.accessor("version", { header: k.nodes.version, cell: ({ row }) => <Mono>{row.original.version}</Mono> }),
    nodeHelper.accessor("internalIP", { header: k.nodes.internalIP, cell: ({ row }) => <Mono>{row.original.internalIP || "—"}</Mono> }),
    nodeHelper.accessor("os", { header: k.nodes.os }),
    nodeHelper.accessor("created", { header: k.common.age, cell: ({ row }) => <Age at={row.original.created} /> }),
  ])
}

/**
 * Names for the Columns menu of the tables below, by column id. English
 * keeps the menu as it always was (the column ids).
 */
function columnLabels({ t, locale }: I18n): Record<string, string> | undefined {
  if (locale === "en") return undefined
  const k = t.kubernetes
  return {
    namespace: k.common.namespace,
    status: t.common.fields.status,
    roles: k.nodes.roles,
    version: k.nodes.version,
    internalIP: k.nodes.internalIP,
    os: k.nodes.os,
    created: k.common.age,
    ready: k.common.ready,
    restarts: k.pods.restarts,
    node: k.pods.node,
    kind: k.common.kind,
    upToDate: k.workloads.upToDate,
    images: k.workloads.images,
    type: t.common.fields.type,
    clusterIP: k.services.clusterIP,
    ports: t.common.fields.ports,
    external: k.services.external,
    className: k.services.className,
    hosts: k.services.hosts,
    address: k.services.address,
    keys: k.common.keys,
    lastSeen: k.events.lastSeen,
    reason: k.events.reason,
    object: k.events.object,
    message: k.events.message,
    count: k.events.count,
  }
}

export function NodesTable({ data }: { data: NodeRow[] }) {
  const i18n = useI18n()
  const columns = React.useMemo(() => nodeColumns(i18n), [i18n])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.name}
      emptyMessage={i18n.t.kubernetes.nodes.empty}
      columnLabels={columnLabels(i18n)}
    />
  )
}

// ---------------------------------------------------------------------- pods

const podHelper = columnHelperFor<PodRow>()

function podColumns({ t, format }: I18n, environmentId: number, canManage: boolean, showNamespace: boolean) {
  const k = t.kubernetes
  return podHelper.columns([
    podHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
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
      ? [podHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title={k.common.namespace} /> })]
      : []),
    podHelper.accessor("status", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.status} />,
      cell: ({ row }) => <KubeStatus status={row.original.status} />,
    }),
    podHelper.accessor("ready", { header: k.common.ready, cell: ({ row }) => <span className="tabular-nums">{row.original.ready}</span> }),
    podHelper.accessor("restarts", {
      header: ({ column }) => <SortHeader column={column} title={k.pods.restarts} />,
      cell: ({ row }) => <span className="tabular-nums">{row.original.restarts}</span>,
    }),
    podHelper.accessor("node", { header: k.pods.node, cell: ({ row }) => row.original.node || <span className="text-muted-foreground">—</span> }),
    podHelper.accessor("created", {
      header: ({ column }) => <SortHeader column={column} title={k.common.age} />,
      cell: ({ row }) => <Age at={row.original.created} />,
    }),
    podHelper.display({
      id: "actions",
      cell: ({ row }) => {
        const p = row.original
        return (
          <div className="flex justify-end gap-1">
            <IconButton label={k.pods.logs} asChild>
              <Link href={`/kubernetes/pods/${encodeURIComponent(p.namespace)}/${encodeURIComponent(p.name)}`}>
                <ScrollTextIcon />
              </Link>
            </IconButton>
            {canManage ? (
              <ConfirmAction
                title={format(k.pods.deleteTitle, { name: p.name })}
                description={format(k.pods.deleteDescription, { namespace: p.namespace, name: p.name })}
                confirmLabel={t.common.actions.delete}
                onConfirm={() => deletePod({ environmentId, namespace: p.namespace, name: p.name })}
              >
                <IconButton label={k.pods.deletePod}>
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
  const i18n = useI18n()
  const columns = React.useMemo(
    () => podColumns(i18n, environmentId, canManage, showNamespace),
    [i18n, environmentId, canManage, showNamespace]
  )
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.status} ${r.node}`}
      searchPlaceholder={i18n.t.kubernetes.pods.search}
      emptyMessage={i18n.t.kubernetes.pods.empty}
      columnLabels={columnLabels(i18n)}
      pageSize={20}
    />
  )
}

// ----------------------------------------------------------------- workloads

function ScaleDialog({ row, environmentId }: { row: WorkloadRow; environmentId: number }) {
  const { t, format } = useI18n()
  const k = t.kubernetes.workloads
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
        <IconButton label={k.scale}>
          <ScalingIcon />
        </IconButton>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{format(k.scaleTitle, { name: row.name })}</DialogTitle>
          <DialogDescription>
            {format(k.scaleDescription, { kind: row.kind, namespace: row.namespace, name: row.name, count: row.desired })}
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
            <FieldLabel htmlFor={`${uid}-replicas`}>{k.replicas}</FieldLabel>
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
            {n === 0 && valid ? <FieldDescription>{format(k.scaleToZero, { kind: row.kind })}</FieldDescription> : null}
            {!valid ? <FieldError>{format(k.replicasInvalid, { max: MAX_REPLICAS })}</FieldError> : null}
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={pending}>
                {t.common.actions.cancel}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending || !valid}>
              {pending ? t.common.status.working : k.scale}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const workloadHelper = columnHelperFor<WorkloadRow>()

function workloadColumns(
  { t, format }: I18n,
  environmentId: number,
  can: { operate: boolean; manage: boolean },
  showNamespace: boolean
) {
  const k = t.kubernetes
  return workloadHelper.columns([
    workloadHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    workloadHelper.accessor("kind", {
      header: ({ column }) => <SortHeader column={column} title={k.common.kind} />,
      cell: ({ row }) => <Badge variant="outline">{row.original.kind}</Badge>,
    }),
    ...(showNamespace
      ? [workloadHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title={k.common.namespace} /> })]
      : []),
    workloadHelper.display({
      id: "ready",
      header: k.common.ready,
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
      header: k.workloads.upToDate,
      cell: ({ row }) => <span className="tabular-nums">{row.original.upToDate}</span>,
    }),
    workloadHelper.display({ id: "images", header: k.workloads.images, cell: ({ row }) => <Tags items={row.original.images} /> }),
    workloadHelper.accessor("created", {
      header: ({ column }) => <SortHeader column={column} title={k.common.age} />,
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
            {can.manage ? <EditYamlLink kind={w.kind} namespace={w.namespace} name={w.name} /> : null}
            <ConfirmAction
              title={format(k.workloads.restartTitle, { name: w.name })}
              description={format(k.workloads.restartDescription, { kind: w.kind, namespace: w.namespace, name: w.name })}
              confirmLabel={t.common.actions.restart}
              destructive={false}
              onConfirm={() => restartWorkload(ref)}
            >
              <IconButton label={t.common.actions.restart}>
                <RotateCwIcon />
              </IconButton>
            </ConfirmAction>
            {can.manage ? (
              <ConfirmAction
                title={format(k.workloads.deleteTitle, { kind: w.kind, name: w.name })}
                description={format(k.workloads.deleteDescription, { kind: w.kind, namespace: w.namespace, name: w.name })}
                confirmLabel={t.common.actions.delete}
                onConfirm={() => deleteWorkload(ref)}
              >
                <IconButton label={t.common.actions.delete}>
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
  const i18n = useI18n()
  const columns = React.useMemo(
    () => workloadColumns(i18n, environmentId, { operate: canOperate, manage: canManage }, showNamespace),
    [i18n, environmentId, canOperate, canManage, showNamespace]
  )
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.kind} ${r.namespace} ${r.images.join(" ")}`}
      searchPlaceholder={i18n.t.kubernetes.workloads.search}
      emptyMessage={i18n.t.kubernetes.workloads.empty}
      columnLabels={columnLabels(i18n)}
      pageSize={20}
    />
  )
}

// ------------------------------------------------------- services, ingresses

const serviceHelper = columnHelperFor<ServiceRow>()

function serviceColumns({ t }: I18n, showNamespace: boolean, canEdit: boolean) {
  const k = t.kubernetes
  return serviceHelper.columns([
    serviceHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    ...(showNamespace
      ? [serviceHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title={k.common.namespace} /> })]
      : []),
    serviceHelper.accessor("type", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.type} />,
      cell: ({ row }) => <Badge variant="outline">{row.original.type}</Badge>,
    }),
    serviceHelper.accessor("clusterIP", { header: k.services.clusterIP, cell: ({ row }) => <Mono>{row.original.clusterIP || "—"}</Mono> }),
    serviceHelper.display({ id: "ports", header: t.common.fields.ports, cell: ({ row }) => <Tags items={row.original.ports} /> }),
    serviceHelper.display({ id: "external", header: k.services.external, cell: ({ row }) => <Tags items={row.original.externalIPs} /> }),
    serviceHelper.accessor("created", { header: k.common.age, cell: ({ row }) => <Age at={row.original.created} /> }),
    ...(canEdit ? [editColumn(serviceHelper, "Service")] : []),
  ])
}

export function ServicesTable({ data, showNamespace, canEdit = false }: { data: ServiceRow[]; showNamespace: boolean; canEdit?: boolean }) {
  const i18n = useI18n()
  const columns = React.useMemo(() => serviceColumns(i18n, showNamespace, canEdit), [i18n, showNamespace, canEdit])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.type} ${r.clusterIP} ${r.ports.join(" ")}`}
      searchPlaceholder={i18n.t.kubernetes.services.search}
      emptyMessage={i18n.t.kubernetes.services.empty}
      columnLabels={columnLabels(i18n)}
      pageSize={20}
    />
  )
}

const ingressHelper = columnHelperFor<IngressRow>()

function ingressColumns({ t }: I18n, showNamespace: boolean, canEdit: boolean) {
  const k = t.kubernetes
  return ingressHelper.columns([
    ingressHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    ...(showNamespace
      ? [ingressHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title={k.common.namespace} /> })]
      : []),
    ingressHelper.accessor("className", { header: k.services.className, cell: ({ row }) => row.original.className || "—" }),
    ingressHelper.display({ id: "hosts", header: k.services.hosts, cell: ({ row }) => <Tags items={row.original.hosts} /> }),
    ingressHelper.display({ id: "address", header: k.services.address, cell: ({ row }) => <Tags items={row.original.address} /> }),
    ingressHelper.accessor("created", { header: k.common.age, cell: ({ row }) => <Age at={row.original.created} /> }),
    ...(canEdit ? [editColumn(ingressHelper, "Ingress")] : []),
  ])
}

export function IngressesTable({ data, showNamespace, canEdit = false }: { data: IngressRow[]; showNamespace: boolean; canEdit?: boolean }) {
  const i18n = useI18n()
  const columns = React.useMemo(() => ingressColumns(i18n, showNamespace, canEdit), [i18n, showNamespace, canEdit])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.hosts.join(" ")}`}
      searchPlaceholder={i18n.t.kubernetes.services.searchIngresses}
      emptyMessage={i18n.t.kubernetes.services.emptyIngresses}
      columnLabels={columnLabels(i18n)}
    />
  )
}

// ---------------------------------------------------------------- namespaces

const namespaceHelper = columnHelperFor<NamespaceRow>()

function namespaceColumns({ t, format }: I18n, environmentId: number, canManage: boolean) {
  const k = t.kubernetes
  return namespaceHelper.columns([
    namespaceHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    namespaceHelper.accessor("status", { header: t.common.fields.status, cell: ({ row }) => <KubeStatus status={row.original.status} /> }),
    namespaceHelper.accessor("created", {
      header: ({ column }) => <SortHeader column={column} title={k.common.age} />,
      cell: ({ row }) => <Age at={row.original.created} />,
    }),
    namespaceHelper.display({
      id: "actions",
      cell: ({ row }) =>
        canManage && !PROTECTED_NAMESPACES.has(row.original.name) && row.original.status !== "Terminating" ? (
          <div className="flex justify-end">
            <ConfirmAction
              title={format(k.namespaces.deleteTitle, { name: row.original.name })}
              description={k.namespaces.deleteDescription}
              confirmLabel={t.common.actions.delete}
              onConfirm={() => deleteNamespace(environmentId, row.original.name)}
            >
              <IconButton label={k.namespaces.deleteNamespace}>
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
  const i18n = useI18n()
  const k = i18n.t.kubernetes.namespaces
  const columns = React.useMemo(() => namespaceColumns(i18n, environmentId, canManage), [i18n, environmentId, canManage])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.name}
      searchText={(r) => r.name}
      searchPlaceholder={k.search}
      emptyMessage={k.empty}
      columnLabels={columnLabels(i18n)}
      pageSize={20}
      toolbar={
        canManage ? (
          <FormDialog
            trigger={
              <Button size="sm">
                <PlusIcon data-icon="inline-start" />
                <span className="hidden lg:inline">{k.create}</span>
              </Button>
            }
            title={k.create}
            submitLabel={i18n.t.common.actions.create}
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
  const { t } = useI18n()
  const uid = React.useId()
  return (
    <Field data-invalid={error ? true : undefined}>
      <input type="hidden" name="environment" value={environmentId} />
      <FieldLabel htmlFor={`${uid}-ns-name`}>{t.common.fields.name}</FieldLabel>
      <Input id={`${uid}-ns-name`} name="name" placeholder="my-app" required autoFocus autoComplete="off" spellCheck={false} />
      <FieldDescription>{t.kubernetes.namespaces.nameHelp}</FieldDescription>
      <FieldError>{error}</FieldError>
    </Field>
  )
}

// ------------------------------------------------------ configmaps, secrets

const cmHelper = columnHelperFor<ConfigMapRow>()

function configMapColumns({ t }: I18n, showNamespace: boolean, canEdit: boolean) {
  const k = t.kubernetes
  return cmHelper.columns([
    cmHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    ...(showNamespace ? [cmHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title={k.common.namespace} /> })] : []),
    cmHelper.display({ id: "keys", header: k.common.keys, cell: ({ row }) => <Tags items={row.original.keys} empty={k.common.noKeys} /> }),
    cmHelper.accessor("created", { header: k.common.age, cell: ({ row }) => <Age at={row.original.created} /> }),
    ...(canEdit ? [editColumn(cmHelper, "ConfigMap")] : []),
  ])
}

export function ConfigMapsTable({ data, showNamespace, canEdit = false }: { data: ConfigMapRow[]; showNamespace: boolean; canEdit?: boolean }) {
  const i18n = useI18n()
  const columns = React.useMemo(() => configMapColumns(i18n, showNamespace, canEdit), [i18n, showNamespace, canEdit])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.keys.join(" ")}`}
      searchPlaceholder={i18n.t.kubernetes.config.searchConfigMaps}
      emptyMessage={i18n.t.kubernetes.config.emptyConfigMaps}
      columnLabels={columnLabels(i18n)}
    />
  )
}

const secretHelper = columnHelperFor<SecretRow>()

function secretColumns({ t }: I18n, showNamespace: boolean, canEdit: boolean) {
  const k = t.kubernetes
  return secretHelper.columns([
    secretHelper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title={t.common.fields.name} />,
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      enableHiding: false,
    }),
    ...(showNamespace
      ? [secretHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title={k.common.namespace} /> })]
      : []),
    secretHelper.accessor("type", { header: t.common.fields.type, cell: ({ row }) => <Mono>{row.original.type}</Mono> }),
    secretHelper.display({ id: "keys", header: k.common.keys, cell: ({ row }) => <Tags items={row.original.keys} empty={k.common.noKeys} /> }),
    secretHelper.accessor("created", { header: k.common.age, cell: ({ row }) => <Age at={row.original.created} /> }),
    ...(canEdit ? [editColumn(secretHelper, "Secret")] : []),
  ])
}

/** `canEdit`: administrators only (the editor shows the Secret's data). */
export function SecretsTable({ data, showNamespace, canEdit = false }: { data: SecretRow[]; showNamespace: boolean; canEdit?: boolean }) {
  const i18n = useI18n()
  const columns = React.useMemo(() => secretColumns(i18n, showNamespace, canEdit), [i18n, showNamespace, canEdit])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.namespace} ${r.type} ${r.keys.join(" ")}`}
      searchPlaceholder={i18n.t.kubernetes.config.searchSecrets}
      emptyMessage={i18n.t.kubernetes.config.emptySecrets}
      columnLabels={columnLabels(i18n)}
    />
  )
}

// -------------------------------------------------------------------- events

const eventHelper = columnHelperFor<EventRow>()

function eventColumns({ t }: I18n, showNamespace: boolean) {
  const k = t.kubernetes
  return eventHelper.columns([
    eventHelper.accessor("lastSeen", {
      header: ({ column }) => <SortHeader column={column} title={k.events.lastSeen} />,
      cell: ({ row }) => <Age at={row.original.lastSeen} />,
    }),
    ...(showNamespace
      ? [eventHelper.accessor("namespace", { header: ({ column }) => <SortHeader column={column} title={k.common.namespace} /> })]
      : []),
    eventHelper.accessor("type", {
      header: t.common.fields.type,
      cell: ({ row }) => (
        <Badge variant="outline" className={cn(row.original.type === "Warning" && "text-amber-600")}>
          {row.original.type}
        </Badge>
      ),
    }),
    eventHelper.accessor("reason", { header: ({ column }) => <SortHeader column={column} title={k.events.reason} /> }),
    eventHelper.accessor("object", { header: k.events.object, cell: ({ row }) => <Mono>{row.original.object}</Mono> }),
    eventHelper.accessor("message", {
      header: k.events.message,
      cell: ({ row }) => <span className="block max-w-xl text-xs break-words whitespace-normal">{row.original.message}</span>,
    }),
    eventHelper.accessor("count", {
      header: k.events.count,
      cell: ({ row }) => <span className="tabular-nums">{row.original.count}</span>,
    }),
  ])
}

export function EventsTable({ data, showNamespace }: { data: EventRow[]; showNamespace: boolean }) {
  const i18n = useI18n()
  const columns = React.useMemo(() => eventColumns(i18n, showNamespace), [i18n, showNamespace])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.namespace} ${r.reason} ${r.object} ${r.message}`}
      searchPlaceholder={i18n.t.kubernetes.events.search}
      emptyMessage={i18n.t.kubernetes.events.empty}
      columnLabels={columnLabels(i18n)}
      pageSize={50}
    />
  )
}
