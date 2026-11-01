"use client"

import * as React from "react"
import { ArrowUpIcon, DownloadIcon, FileIcon, FileSymlinkIcon, FileTextIcon, FolderIcon, Trash2Icon } from "lucide-react"

import { ConfirmAction } from "@/components/gantry/confirm-button"
import { Mono } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { entryOwner, entryTypeLabel } from "@/lib/files/browser"
import { formatMode, type FileEntry, type Listing } from "@/lib/files/entries"
import { joinPath, parentPath } from "@/lib/files/paths"
import { useI18n } from "@/lib/i18n/client"
import { cn } from "@/lib/utils"
import type { ActionState } from "@/lib/validation"

// The listing table of the file browser (components/gantry/file-browser.tsx).

type RowActions = {
  canWrite: boolean
  /** Why deleting is impossible here, or null. */
  deleteBlocker: string | null
  downloadUrl: (path: string) => string
  /** Opens a folder (or a followable link to one). */
  onOpen: (path: string) => void
  guardWrite: (fn: () => void) => void
}

export function EntriesTable({
  listing,
  path,
  linkPath,
  onEdit,
  onDelete,
  ...actions
}: RowActions & {
  listing: Listing
  /** The folder shown. */
  path: string
  /** Where an entry's symbolic link leads, when it can be followed. */
  linkPath: (entry: FileEntry) => string | null
  onEdit: (entry: FileEntry) => void
  onDelete: (entry: FileEntry) => Promise<ActionState>
}) {
  const { t } = useI18n()
  const text = t.files
  return (
    <div className="rounded-lg border">
      <Table aria-label={text.title}>
        <TableHeader>
          <TableRow>
            <TableHead>{text.columns.name}</TableHead>
            <TableHead>{text.columns.type}</TableHead>
            <TableHead className="text-right">{text.columns.size}</TableHead>
            <TableHead>{text.columns.mode}</TableHead>
            <TableHead>{text.columns.owner}</TableHead>
            <TableHead>{text.columns.modified}</TableHead>
            <TableHead className="w-0">
              <span className="sr-only">{text.columns.actions}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {path !== "/" ? (
            <TableRow>
              <TableCell colSpan={7}>
                <Button variant="ghost" size="xs" onClick={() => actions.onOpen(parentPath(path))} aria-label={text.parentFolder}>
                  <ArrowUpIcon data-icon="inline-start" />
                  ..
                </Button>
              </TableCell>
            </TableRow>
          ) : null}
          {listing.entries.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-muted-foreground">
                {text.emptyFolder}
              </TableCell>
            </TableRow>
          ) : null}
          {listing.entries.map((e) => (
            <EntryRow
              key={e.name}
              entry={e}
              path={joinPath(path, e.name)}
              linkPath={linkPath(e)}
              onEdit={() => onEdit(e)}
              onDelete={() => onDelete(e)}
              {...actions}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function formatTime(seconds: number, formatDate: (date: number) => string) {
  if (!seconds) return "—"
  return formatDate(seconds * 1000)
}

function EntryRow({
  entry: e,
  path,
  linkPath,
  canWrite,
  deleteBlocker,
  downloadUrl,
  onOpen,
  onEdit,
  onDelete,
  guardWrite,
}: RowActions & {
  entry: FileEntry
  path: string
  linkPath: string | null
  onEdit: () => void
  onDelete: () => Promise<ActionState>
}) {
  const i18n = useI18n()
  const { t, format } = i18n
  const text = t.files
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const Icon = e.type === "dir" ? FolderIcon : e.type === "symlink" ? FileSymlinkIcon : FileIcon
  const openable = e.type === "dir" || (e.type === "symlink" && linkPath !== null)
  const fileLike = e.type === "file" || (e.type === "symlink" && linkPath !== null)
  const readPath = e.type === "symlink" ? linkPath : path

  return (
    <TableRow data-testid={`file-row-${e.name}`}>
      <TableCell className="max-w-96">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className={cn("size-4 shrink-0", e.type === "dir" ? "text-sky-600 dark:text-sky-400" : "text-muted-foreground")} />
          {openable ? (
            <button
              type="button"
              className="truncate text-left font-medium underline-offset-4 hover:underline"
              onClick={() => onOpen(e.type === "dir" ? path : linkPath!)}
              aria-label={format(text.open, { name: e.name })}
            >
              {e.name}
            </button>
          ) : (
            <span className="truncate">{e.name}</span>
          )}
          {e.linkTarget && e.type === "symlink" ? (
            <Mono className="truncate text-muted-foreground" title={e.linkTarget}>
              → {e.linkTarget}
            </Mono>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{entryTypeLabel(e, text.types)}</TableCell>
      <TableCell className="text-right tabular-nums">{e.type === "file" ? i18n.formatBytes(e.size) : "—"}</TableCell>
      <TableCell>
        <Mono>{formatMode(e)}</Mono>
      </TableCell>
      <TableCell>
        <Mono>{entryOwner(e)}</Mono>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">{formatTime(e.mtime, i18n.formatDate)}</TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {fileLike ? (
            <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={format(canWrite ? text.edit : text.view, { name: e.name })}>
              <FileTextIcon />
            </Button>
          ) : null}
          {readPath && e.type !== "other" ? (
            <Button variant="ghost" size="icon-sm" asChild>
              <a href={downloadUrl(readPath)} download aria-label={format(text.download, { name: e.name })}>
                <DownloadIcon />
              </a>
            </Button>
          ) : null}
          {canWrite ? (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                disabled={deleteBlocker !== null}
                title={deleteBlocker ?? undefined}
                aria-label={format(text.delete, { name: e.name })}
                onClick={() => guardWrite(() => setConfirmOpen(true))}
              >
                <Trash2Icon />
              </Button>
              <ConfirmAction
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title={format(text.deleteTitle, { name: e.name })}
                description={format(e.type === "dir" ? text.deleteFolder : text.deleteFile, { path })}
                confirmLabel={t.common.actions.delete}
                onConfirm={onDelete}
              />
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  )
}
