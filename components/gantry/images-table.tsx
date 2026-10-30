"use client"

import * as React from "react"
import { DownloadIcon, EraserIcon, Trash2Icon } from "lucide-react"

import { pruneImages, pullImage, removeImage, removeImages } from "@/app/(app)/images/actions"
import { columnHelperFor, DataTable, SortHeader, type TableSelection } from "@/components/data-table"
import { BulkConfirm } from "@/components/gantry/bulk"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export type ImageRow = {
  id: string
  shortId: string
  tags: string[]
  size: number
  sizeLabel: string
  created: number
  createdLabel: string
  inUse: number
}

const helper = columnHelperFor<ImageRow>()

function buildColumns(isAdmin: boolean) {
  return helper.columns([
    helper.accessor((r) => r.tags[0] ?? "<none>", {
      id: "tags",
      header: ({ column }) => <SortHeader column={column} title="Tags" />,
      cell: ({ row }) =>
        row.original.tags.length ? (
          <div className="flex max-w-96 flex-wrap gap-1">
            {row.original.tags.map((t) => (
              <Mono key={t} className="rounded bg-muted px-1.5 py-0.5">
                {t}
              </Mono>
            ))}
          </div>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            dangling
          </Badge>
        ),
      enableHiding: false,
    }),
    helper.accessor("shortId", {
      header: "ID",
      cell: ({ row }) => <Mono className="text-muted-foreground">{row.original.shortId}</Mono>,
    }),
    helper.accessor("inUse", {
      header: ({ column }) => <SortHeader column={column} title="Used by" />,
      cell: ({ row }) =>
        row.original.inUse > 0 ? (
          <Badge variant="outline">{row.original.inUse} container(s)</Badge>
        ) : (
          <span className="text-muted-foreground">Unused</span>
        ),
    }),
    helper.accessor("size", {
      header: ({ column }) => <SortHeader column={column} title="Size" />,
      cell: ({ row }) => <span className="tabular-nums">{row.original.sizeLabel}</span>,
    }),
    helper.accessor("created", {
      header: ({ column }) => <SortHeader column={column} title="Created" />,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdLabel}</span>,
    }),
    helper.display({
      id: "actions",
      cell: ({ row }) => (isAdmin ? <RemoveImage row={row.original} /> : null),
      enableHiding: false,
    }),
  ])
}

export function ImagesTable({ data, isAdmin }: { data: ImageRow[]; isAdmin: boolean }) {
  const columns = React.useMemo(() => buildColumns(isAdmin), [isAdmin])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      selection={isAdmin ? imageSelection : undefined}
      searchText={(r) => `${r.tags.join(" ")} ${r.shortId}`}
      searchPlaceholder="Search images…"
      emptyMessage="No images."
      pageSize={20}
      toolbar={
        isAdmin ? (
          <>
            <ConfirmAction
              title="Prune dangling images?"
              description="Untagged images that no container uses will be deleted."
              confirmLabel="Prune"
              onConfirm={pruneImages}
            >
              <Button size="sm" variant="outline">
                <EraserIcon data-icon="inline-start" />
                <span className="hidden lg:inline">Prune</span>
              </Button>
            </ConfirmAction>
            <PullImageDialog />
          </>
        ) : null
      }
    />
  )
}

const imageName = (r: ImageRow) => r.tags[0] ?? r.shortId

const imageSelection: TableSelection<ImageRow> = {
  rowLabel: imageName,
  actions: (selected, clear) => <BulkRemoveImages selected={selected} clear={clear} />,
}

function BulkRemoveImages({ selected, clear }: { selected: ImageRow[]; clear: () => void }) {
  const [force, setForce] = React.useState(false)
  const inUse = selected.filter((r) => r.inUse > 0).length
  const multiTag = selected.filter((r) => r.tags.length > 1).length
  const warnings = [
    inUse ? `${inUse} in use by containers` : null,
    !force && multiTag ? `${multiTag} with several tags (needs force)` : null,
  ].filter(Boolean)
  return (
    <BulkConfirm
      label="Remove"
      icon={<Trash2Icon data-icon="inline-start" />}
      title={`Remove ${selected.length} image(s)?`}
      description="These images will be deleted from this environment."
      names={selected.map(imageName)}
      warning={warnings.length ? `Some may fail: ${warnings.join(", ")}.` : null}
      onConfirm={() => removeImages(selected.map((r) => ({ id: r.id, name: imageName(r) })), force)}
      onDone={clear}
      extra={
        <Label className="font-normal">
          <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
          Force (remove even if tagged multiple times or used by stopped containers)
        </Label>
      }
    />
  )
}

function RemoveImage({ row }: { row: ImageRow }) {
  const [force, setForce] = React.useState(false)
  return (
    <div className="flex justify-end">
      <ConfirmAction
        title={`Remove ${row.tags[0] ?? row.shortId}?`}
        description="The image will be deleted from this environment."
        confirmLabel="Remove"
        onConfirm={() => removeImage(row.id, force)}
        extra={
          <Label className="font-normal">
            <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
            Force (remove even if tagged multiple times or used by stopped containers)
          </Label>
        }
      >
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Remove image">
          <Trash2Icon />
        </Button>
      </ConfirmAction>
    </div>
  )
}

function PullImageDialog() {
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <DownloadIcon data-icon="inline-start" />
          <span className="hidden lg:inline">Pull image</span>
        </Button>
      }
      title="Pull image"
      description="Download an image from a registry. Large images can take a while."
      submitLabel="Pull"
      action={pullImage}
    >
      {(errors) => (
        <Field data-invalid={errors.image ? true : undefined}>
          <FieldLabel htmlFor="image">Image</FieldLabel>
          <Input id="image" name="image" placeholder="nginx:latest" required autoFocus />
          <FieldDescription>Defaults to the :latest tag when none is given.</FieldDescription>
          <FieldError>{errors.image?.[0]}</FieldError>
        </Field>
      )}
    </FormDialog>
  )
}
