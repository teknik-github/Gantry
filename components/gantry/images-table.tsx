"use client"

import * as React from "react"
import { DownloadIcon, EraserIcon, Trash2Icon } from "lucide-react"

import { pruneImages, pullImage, removeImage, removeImages } from "@/app/(app)/images/actions"
import { columnHelperFor, DataTable, SortHeader, type TableSelection } from "@/components/data-table"
import { BulkConfirm } from "@/components/gantry/bulk"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { FormDialog } from "@/components/gantry/form-dialog"
import { BulkScanImages, ScanImageButton, VulnerabilityCell } from "@/components/gantry/image-scan-ui"
import { ImageTagPushActions } from "@/components/gantry/image-tag-push"
import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"

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

function buildColumns(i18n: I18n, canManage: boolean, canOperate: boolean) {
  const { t } = i18n
  const c = t.images.columns
  return helper.columns([
    helper.accessor((r) => r.tags[0] ?? "<none>", {
      id: "tags",
      header: ({ column }) => <SortHeader column={column} title={c.tags} />,
      cell: ({ row }) =>
        row.original.tags.length ? (
          <div className="flex max-w-96 flex-wrap gap-1">
            {row.original.tags.map((tag) => (
              <Mono key={tag} className="rounded bg-muted px-1.5 py-0.5">
                {tag}
              </Mono>
            ))}
          </div>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            {t.images.dangling}
          </Badge>
        ),
      enableHiding: false,
    }),
    helper.accessor("shortId", {
      header: c.id,
      cell: ({ row }) => <Mono className="text-muted-foreground">{row.original.shortId}</Mono>,
    }),
    helper.accessor("inUse", {
      header: ({ column }) => <SortHeader column={column} title={c.usedBy} />,
      cell: ({ row }) =>
        row.original.inUse > 0 ? (
          <Badge variant="outline">{i18n.format(t.images.containersCount, { count: row.original.inUse })}</Badge>
        ) : (
          <span className="text-muted-foreground">{t.images.unused}</span>
        ),
    }),
    helper.display({
      id: "vulnerabilities",
      header: c.vulnerabilities,
      cell: ({ row }) => <VulnerabilityCell imageId={row.original.id} name={imageName(row.original)} />,
    }),
    helper.accessor("size", {
      header: ({ column }) => <SortHeader column={column} title={c.size} />,
      cell: ({ row }) => <span className="tabular-nums">{row.original.sizeLabel}</span>,
    }),
    helper.accessor("created", {
      header: ({ column }) => <SortHeader column={column} title={c.created} />,
      cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdLabel}</span>,
    }),
    helper.display({
      id: "actions",
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          {canOperate ? <ScanImageButton imageId={row.original.id} name={imageName(row.original)} /> : null}
          {canManage ? (
            <>
              <ImageTagPushActions row={row.original} />
              <RemoveImage row={row.original} />
            </>
          ) : null}
        </div>
      ),
      enableHiding: false,
    }),
  ])
}

export function ImagesTable({ data, canManage, canOperate = false }: { data: ImageRow[]; canManage: boolean; canOperate?: boolean }) {
  const i18n = useI18n()
  const { t } = i18n
  const environmentId = useEnvironmentId()
  const columns = React.useMemo(() => buildColumns(i18n, canManage, canOperate), [i18n, canManage, canOperate])
  const selection = React.useMemo(() => imageSelection(canManage), [canManage])
  return (
    <DataTable
      data={data}
      columns={columns}
      getRowId={(r) => r.id}
      selection={canOperate ? selection : undefined}
      searchText={(r) => `${r.tags.join(" ")} ${r.shortId}`}
      searchPlaceholder={t.images.searchPlaceholder}
      emptyMessage={t.images.empty}
      columnLabels={{ ...t.images.columns, shortId: t.images.columns.id, inUse: t.images.columns.usedBy }}
      pageSize={20}
      toolbar={
        canManage ? (
          <>
            <ConfirmAction
              title={t.images.pruneTitle}
              description={t.images.pruneDescription}
              confirmLabel={t.images.prune}
              onConfirm={() => pruneImages(environmentId)}
            >
              <Button size="sm" variant="outline">
                <EraserIcon data-icon="inline-start" />
                <span className="hidden lg:inline">{t.images.prune}</span>
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

const imageSelection = (canManage: boolean): TableSelection<ImageRow> => ({
  rowLabel: imageName,
  actions: (selected, clear) => (
    <>
      <BulkScanImages selected={selected.map((r) => ({ id: r.id, name: imageName(r) }))} clear={clear} />
      {canManage ? <BulkRemoveImages selected={selected} clear={clear} /> : null}
    </>
  ),
})

function BulkRemoveImages({ selected, clear }: { selected: ImageRow[]; clear: () => void }) {
  const i18n = useI18n()
  const { t } = i18n
  const environmentId = useEnvironmentId()
  const [force, setForce] = React.useState(false)
  const inUse = selected.filter((r) => r.inUse > 0).length
  const multiTag = selected.filter((r) => r.tags.length > 1).length
  const warnings = [
    inUse ? i18n.format(t.images.bulkInUse, { count: inUse }) : null,
    !force && multiTag ? i18n.format(t.images.bulkMultiTag, { count: multiTag }) : null,
  ].filter(Boolean)
  return (
    <BulkConfirm
      label={t.common.actions.remove}
      icon={<Trash2Icon data-icon="inline-start" />}
      title={i18n.format(t.images.bulkRemoveTitle, { count: selected.length })}
      description={t.images.bulkRemoveDescription}
      names={selected.map(imageName)}
      warning={warnings.length ? i18n.format(t.images.bulkRemoveWarning, { reasons: warnings.join(", ") }) : null}
      onConfirm={() => removeImages(selected.map((r) => ({ id: r.id, name: imageName(r) })), force, environmentId)}
      onDone={clear}
      extra={
        <Label className="font-normal">
          <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
          {t.images.force}
        </Label>
      }
    />
  )
}

function RemoveImage({ row }: { row: ImageRow }) {
  const i18n = useI18n()
  const { t } = i18n
  const environmentId = useEnvironmentId()
  const [force, setForce] = React.useState(false)
  return (
    <div className="flex justify-end">
      <ConfirmAction
        title={i18n.format(t.images.removeTitle, { name: row.tags[0] ?? row.shortId })}
        description={t.images.removeDescription}
        confirmLabel={t.common.actions.remove}
        onConfirm={() => removeImage(row.id, force, environmentId)}
        extra={
          <Label className="font-normal">
            <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} />
            {t.images.force}
          </Label>
        }
      >
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={t.images.removeLabel}>
          <Trash2Icon />
        </Button>
      </ConfirmAction>
    </div>
  )
}

function PullImageDialog() {
  const { t } = useI18n()
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <DownloadIcon data-icon="inline-start" />
          <span className="hidden lg:inline">{t.images.pull.trigger}</span>
        </Button>
      }
      title={t.images.pull.title}
      description={t.images.pull.description}
      submitLabel={t.common.actions.pull}
      action={pullImage}
    >
      {(errors) => (
        <Field data-invalid={errors.image ? true : undefined}>
          <FieldLabel htmlFor="image">{t.images.pull.image}</FieldLabel>
          <Input id="image" name="image" placeholder="nginx:latest" required autoFocus />
          <FieldDescription>{t.images.pull.help}</FieldDescription>
          <FieldError>{errors.image?.[0]}</FieldError>
        </Field>
      )}
    </FormDialog>
  )
}
