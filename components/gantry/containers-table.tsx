"use client"

import * as React from "react"
import Link from "next/link"
import {
  CloudDownloadIcon,
  EllipsisVerticalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCwIcon,
  SquareIcon,
  Trash2Icon,
  ZapIcon,
  FileTextIcon,
  TerminalSquareIcon,
} from "lucide-react"

import { containerAction, createContainer, removeContainer } from "@/app/(app)/containers/actions"
import { columnHelperFor, DataTable, SortHeader } from "@/components/data-table"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { PullRecreateConfirm } from "@/components/gantry/container-edit-dialog"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono, StateBadge } from "@/components/gantry/ui"
import { useRunAction } from "@/components/gantry/use-action"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { ContainerAction } from "@/lib/server/docker/api"

export type ContainerRow = {
  id: string
  name: string
  image: string
  state: string
  status: string
  created: number
  createdLabel: string
  ports: string[]
  stack: string | null
}

const helper = columnHelperFor<ContainerRow>()

function buildColumns(isAdmin: boolean) {
  return helper.columns([
    helper.accessor("name", {
      header: ({ column }) => <SortHeader column={column} title="Name" />,
      cell: ({ row }) => (
        <Link
          href={`/containers/${row.original.id}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {row.original.name}
        </Link>
      ),
      enableHiding: false,
    }),
    helper.accessor("state", {
      header: ({ column }) => <SortHeader column={column} title="State" />,
      cell: ({ row }) => <StateBadge state={row.original.state} />,
    }),
    helper.accessor("image", {
      header: ({ column }) => <SortHeader column={column} title="Image" />,
      cell: ({ row }) => <Mono className="block max-w-64 truncate">{row.original.image}</Mono>,
    }),
    helper.accessor("stack", {
      header: "Stack",
      cell: ({ row }) => row.original.stack ?? <span className="text-muted-foreground">—</span>,
    }),
    helper.accessor("ports", {
      header: "Ports",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.ports.length ? (
          <div className="flex max-w-56 flex-wrap gap-1">
            {row.original.ports.map((p) => (
              <Mono key={p} className="rounded bg-muted px-1.5 py-0.5">
                {p}
              </Mono>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    }),
    helper.accessor("created", {
      header: ({ column }) => <SortHeader column={column} title="Created" />,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdLabel}</span>,
    }),
    helper.display({
      id: "actions",
      cell: ({ row }) => <RowActions row={row.original} isAdmin={isAdmin} />,
      enableHiding: false,
    }),
  ])
}

export function ContainersTable({
  data,
  isAdmin,
  pageSize,
}: {
  data: ContainerRow[]
  isAdmin: boolean
  pageSize?: number
}) {
  const columns = React.useMemo(() => buildColumns(isAdmin), [isAdmin])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      searchText={(r) => `${r.name} ${r.image} ${r.state} ${r.stack ?? ""}`}
      searchPlaceholder="Search containers…"
      emptyMessage="No containers."
      pageSize={pageSize}
      toolbar={isAdmin ? <CreateContainerDialog /> : null}
    />
  )
}

function RowActions({ row, isAdmin }: { row: ContainerRow; isAdmin: boolean }) {
  const [pending, run] = useRunAction()
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [confirmPull, setConfirmPull] = React.useState(false)
  const [force, setForce] = React.useState(false)
  const [volumes, setVolumes] = React.useState(false)

  const running = row.state === "running"
  const paused = row.state === "paused"
  const act = (action: ContainerAction, label: string) =>
    run(() => containerAction(row.id, action), `${row.name}: ${label}`)

  return (
    <div className="flex justify-end">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" disabled={pending}>
            <EllipsisVerticalIcon />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem asChild>
            <Link href={`/containers/${row.id}`}>
              <FileTextIcon />
              Details & logs
            </Link>
          </DropdownMenuItem>
          {isAdmin && running ? (
            <DropdownMenuItem asChild>
              <Link href={`/containers/${row.id}?tab=console`}>
                <TerminalSquareIcon />
                Console
              </Link>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          {!running && !paused ? (
            <DropdownMenuItem onSelect={() => act("start", "started")}>
              <PlayIcon />
              Start
            </DropdownMenuItem>
          ) : null}
          {running ? (
            <DropdownMenuItem onSelect={() => act("stop", "stopped")}>
              <SquareIcon />
              Stop
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => act("restart", "restarted")}>
            <RotateCwIcon />
            Restart
          </DropdownMenuItem>
          {running ? (
            <DropdownMenuItem onSelect={() => act("pause", "paused")}>
              <PauseIcon />
              Pause
            </DropdownMenuItem>
          ) : null}
          {paused ? (
            <DropdownMenuItem onSelect={() => act("unpause", "resumed")}>
              <PlayIcon />
              Resume
            </DropdownMenuItem>
          ) : null}
          {running ? (
            <DropdownMenuItem onSelect={() => act("kill", "killed")}>
              <ZapIcon />
              Kill
            </DropdownMenuItem>
          ) : null}
          {isAdmin ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setConfirmPull(true)}>
                <CloudDownloadIcon />
                Pull & recreate
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmRemove(true)}>
                <Trash2Icon />
                Remove
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {isAdmin ? (
        <PullRecreateConfirm
          open={confirmPull}
          onOpenChange={setConfirmPull}
          id={row.id}
          name={row.name}
          image={row.image}
          composeProject={row.stack}
        />
      ) : null}
      <ConfirmAction
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${row.name}?`}
        description="The container and its writable layer will be deleted. This cannot be undone."
        confirmLabel="Remove"
        onConfirm={() => removeContainer(row.id, { force, volumes })}
        extra={
          <div className="flex flex-col gap-3">
            <Label className="font-normal">
              <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
              Force (stop it first if running)
            </Label>
            <Label className="font-normal">
              <Checkbox checked={volumes} onCheckedChange={(v) => setVolumes(v === true)} />
              Also remove anonymous volumes
            </Label>
          </div>
        }
      />
    </div>
  )
}

function CreateContainerDialog() {
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <PlusIcon data-icon="inline-start" />
          <span className="hidden lg:inline">Add container</span>
        </Button>
      }
      title="Create container"
      description="Run a new container from an image."
      submitLabel="Create"
      action={createContainer}
      className="sm:max-w-lg"
    >
      {(errors) => (
        <FieldGroup className="max-h-[65vh] gap-4 overflow-y-auto pr-1">
          <Field data-invalid={errors.image ? true : undefined}>
            <FieldLabel htmlFor="c-image">Image</FieldLabel>
            <Input id="c-image" name="image" placeholder="nginx:latest" required />
            <FieldError>{errors.image?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.name ? true : undefined}>
            <FieldLabel htmlFor="c-name">Name</FieldLabel>
            <Input id="c-name" name="name" placeholder="web (optional)" />
            <FieldError>{errors.name?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.ports ? true : undefined}>
            <FieldLabel htmlFor="c-ports">Port mappings</FieldLabel>
            <Textarea id="c-ports" name="ports" placeholder={"8080:80\n127.0.0.1:5432:5432/tcp"} rows={2} className="font-mono text-xs" />
            <FieldDescription>One per line: host:container[/tcp|udp]</FieldDescription>
            <FieldError>{errors.ports?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.env ? true : undefined}>
            <FieldLabel htmlFor="c-env">Environment variables</FieldLabel>
            <Textarea id="c-env" name="env" placeholder={"TZ=Asia/Jakarta\nNODE_ENV=production"} rows={3} className="font-mono text-xs" />
            <FieldError>{errors.env?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errors.volumes ? true : undefined}>
            <FieldLabel htmlFor="c-volumes">Volumes</FieldLabel>
            <Textarea id="c-volumes" name="volumes" placeholder={"app-data:/data\n/srv/config:/etc/app:ro"} rows={2} className="font-mono text-xs" />
            <FieldDescription>One per line: volume-or-host-path:/container/path[:ro]</FieldDescription>
            <FieldError>{errors.volumes?.[0]}</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="c-command">Command</FieldLabel>
            <Input id="c-command" name="command" placeholder="(image default)" className="font-mono text-xs" />
          </Field>
          <Field>
            <FieldLabel htmlFor="c-restart">Restart policy</FieldLabel>
            <Select name="restart" defaultValue="unless-stopped">
              <SelectTrigger id="c-restart" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no">Never</SelectItem>
                <SelectItem value="always">Always</SelectItem>
                <SelectItem value="unless-stopped">Unless stopped</SelectItem>
                <SelectItem value="on-failure">On failure</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div className="flex flex-wrap gap-6">
            <Label className="font-normal">
              <Checkbox name="pull" value="on" defaultChecked />
              Pull image first
            </Label>
            <Label className="font-normal">
              <Checkbox name="start" value="on" defaultChecked />
              Start after creating
            </Label>
          </div>
        </FieldGroup>
      )}
    </FormDialog>
  )
}
