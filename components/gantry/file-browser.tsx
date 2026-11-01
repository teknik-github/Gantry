"use client"

import * as React from "react"
import { DownloadIcon, FolderPlusIcon, HardDriveIcon, RefreshCwIcon, TriangleAlertIcon, UploadIcon } from "lucide-react"
import { toast } from "sonner"

import { createFolderAction, deletePathAction } from "@/app/(app)/files/actions"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import {
  EditFileDialog,
  NewFolderDialog,
  UploadConflictDialog,
  WriteWarningDialog,
} from "@/components/gantry/file-browser-dialogs"
import { EntriesTable } from "@/components/gantry/file-browser-table"
import { useDirectoryListing, useFileDrop, useUploads, useWriteGuard } from "@/components/gantry/use-file-browser"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { followableLink } from "@/lib/files/browser"
import { targetQuery, type FileEntry, type FileTarget, type Listing } from "@/lib/files/entries"
import { joinPath, normalizePath, pathSegments } from "@/lib/files/paths"
import { useI18n } from "@/lib/i18n/client"
import { cn } from "@/lib/utils"
import type { ActionState } from "@/lib/validation"

export type FileBrowserProps = {
  target: FileTarget
  /** Shown as the root of the breadcrumb (container or volume name). */
  rootLabel: string
  /** Manager: upload, new folder, edit, delete. */
  canWrite: boolean
  /** Why deleting is impossible here (e.g. a stopped container), or null. */
  deleteBlocker?: string | null
  /** Asked to confirm once before the first change (e.g. a volume in use). */
  writeWarning?: string | null
  limits: { uploadMaxBytes: number; editMaxBytes: number }
  initialPath?: string
}

export function FileBrowser({
  target,
  rootLabel,
  canWrite,
  deleteBlocker,
  writeWarning,
  limits,
  initialPath = "/",
}: FileBrowserProps) {
  const { t } = useI18n()
  const text = t.files
  const environmentId = useEnvironmentId()
  const [editing, setEditing] = React.useState<FileEntry | null>(null)
  const [newFolderOpen, setNewFolderOpen] = React.useState(false)

  const query = React.useMemo(() => targetQuery(target).toString(), [target])
  const { listing, error, loading, path, pathInput, typePath, navigate, reload } = useDirectoryListing(query, initialPath)
  const writes = useWriteGuard(writeWarning)
  const { guardWrite } = writes
  const uploads = useUploads({
    query,
    path,
    listing,
    canWrite,
    uploadMaxBytes: limits.uploadMaxBytes,
    guardWrite,
    reload,
  })
  const { dragging, handlers: dropHandlers } = useFileDrop(canWrite, uploads.startUpload)

  const linkPath = (e: FileEntry) => followableLink(target, path, e)
  const downloadUrl = (p: string) => `/api/files/download?${query}&path=${encodeURIComponent(p)}`
  /** Runs a Server Action on the folder shown; reloads it when that worked. */
  const thenReload = (promise: Promise<ActionState>) =>
    promise.then((res) => {
      if (res.ok) reload()
      return res
    })

  return (
    <Card data-testid="file-browser" className={cn(dragging && "ring-2 ring-primary")} {...dropHandlers}>
      <CardHeader>
        <CardTitle>{text.title}</CardTitle>
        <CardDescription>{canWrite ? text.descriptionWrite : text.descriptionRead}</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          <Toolbar
            canWrite={canWrite}
            loading={loading}
            busy={loading || uploads.uploading !== null}
            folderDownloadUrl={downloadUrl(path)}
            onReload={reload}
            onNewFolder={() => guardWrite(() => setNewFolderOpen(true))}
            onUpload={uploads.startUpload}
          />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <PathBar rootLabel={rootLabel} path={path} pathInput={pathInput} onPathInput={typePath} navigate={navigate} />
        <ListingNotes listing={listing} deleteBlocker={canWrite ? deleteBlocker : null} uploading={uploads.uploading} />

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : !listing ? (
          <p className="text-sm text-muted-foreground">{t.common.status.loading}</p>
        ) : (
          <EntriesTable
            listing={listing}
            path={path}
            linkPath={linkPath}
            canWrite={canWrite}
            deleteBlocker={deleteBlocker ?? null}
            downloadUrl={downloadUrl}
            onOpen={navigate}
            onEdit={setEditing}
            onDelete={(e) => thenReload(deletePathAction(target, joinPath(path, e.name), environmentId))}
            guardWrite={guardWrite}
          />
        )}
      </CardContent>

      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        onCreate={(name) => thenReload(createFolderAction(target, path, name, environmentId))}
      />

      {editing ? (
        <EditFileDialog
          key={`${path}/${editing.name}`}
          query={query}
          dir={path}
          entry={editing}
          linkPath={linkPath(editing)}
          canWrite={canWrite}
          limit={limits.editMaxBytes}
          guardWrite={guardWrite}
          onClose={(saved) => {
            setEditing(null)
            if (saved) reload()
          }}
        />
      ) : null}

      <UploadConflictDialog
        conflicts={uploads.conflicts}
        onSkip={uploads.skipExisting}
        onReplace={uploads.replaceExisting}
        onDismiss={uploads.dismissConflicts}
      />
      <WriteWarningDialog open={writes.pending} warning={writeWarning} onContinue={writes.confirm} onCancel={writes.cancel} />
    </Card>
  )
}

/** Refresh, download the folder, and for managers: new folder and upload. */
function Toolbar({
  canWrite,
  loading,
  busy,
  folderDownloadUrl,
  onReload,
  onNewFolder,
  onUpload,
}: {
  canWrite: boolean
  loading: boolean
  /** Loading or uploading: no new folder or upload meanwhile. */
  busy: boolean
  folderDownloadUrl: string
  onReload: () => void
  onNewFolder: () => void
  onUpload: (files: FileList | null) => void
}) {
  const { t } = useI18n()
  const text = t.files
  const fileInput = React.useRef<HTMLInputElement>(null)
  return (
    <>
      <Button size="icon-sm" variant="outline" onClick={onReload} disabled={loading} aria-label={text.refresh}>
        <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
      </Button>
      <Button size="sm" variant="outline" asChild>
        <a href={folderDownloadUrl} download aria-label={text.downloadFolderLabel}>
          <DownloadIcon data-icon="inline-start" />
          {text.downloadFolder}
        </a>
      </Button>
      {canWrite ? (
        <>
          <Button size="sm" variant="outline" onClick={onNewFolder} disabled={busy}>
            <FolderPlusIcon data-icon="inline-start" />
            {text.newFolder}
          </Button>
          <Button size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
            <UploadIcon data-icon="inline-start" />
            {t.common.actions.upload}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            aria-label={text.filesToUpload}
            onChange={(e) => {
              onUpload(e.currentTarget.files)
              e.currentTarget.value = ""
            }}
          />
        </>
      ) : null}
    </>
  )
}

/** Breadcrumb of the folder shown, and a box to type a path. */
function PathBar({
  rootLabel,
  path,
  pathInput,
  onPathInput,
  navigate,
}: {
  rootLabel: string
  path: string
  pathInput: string
  onPathInput: (value: string) => void
  navigate: (path: string) => void
}) {
  const { t, format } = useI18n()
  const text = t.files
  const inputId = React.useId()
  const segments = pathSegments(path)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <nav aria-label={text.path} className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
        <Button variant="ghost" size="xs" onClick={() => navigate("/")} aria-label={format(text.root, { name: rootLabel })}>
          <HardDriveIcon data-icon="inline-start" />
          {rootLabel}
        </Button>
        {segments.map((s, i) => (
          <React.Fragment key={s.path}>
            <span className="text-muted-foreground">/</span>
            {i === segments.length - 1 ? (
              <span className="px-1 font-medium" aria-current="page">
                {s.name}
              </span>
            ) : (
              <Button variant="ghost" size="xs" onClick={() => navigate(s.path)}>
                {s.name}
              </Button>
            )}
          </React.Fragment>
        ))}
      </nav>
      <form
        className="ml-auto flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          try {
            navigate(normalizePath(pathInput))
          } catch (err) {
            toast.error((err as Error).message)
          }
        }}
      >
        <label htmlFor={`${inputId}-path`} className="sr-only">
          {text.goToPath}
        </label>
        <Input
          id={`${inputId}-path`}
          value={pathInput}
          onChange={(e) => onPathInput(e.target.value)}
          className="h-7 w-56 font-mono text-xs"
        />
        <Button size="sm" variant="outline" type="submit">
          {text.go}
        </Button>
      </form>
    </div>
  )
}

/** Notes above the table: archive listing, truncation, why deleting is off, upload progress. */
function ListingNotes({
  listing,
  deleteBlocker,
  uploading,
}: {
  listing: Listing | null
  /** Shown to managers only (null otherwise). */
  deleteBlocker: string | null | undefined
  uploading: string | null
}) {
  const { t, format } = useI18n()
  const text = t.files
  return (
    <>
      {listing?.source === "archive" ? (
        <p className="text-xs text-muted-foreground" data-testid="files-archive-note">
          {text.archiveNote}
        </p>
      ) : null}
      {listing?.truncated ? (
        <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlertIcon className="size-3.5" />
          {listing.truncated}
        </p>
      ) : null}
      {deleteBlocker ? (
        <p className="text-xs text-muted-foreground" data-testid="files-delete-blocker">
          {format(text.deleteUnavailable, { reason: deleteBlocker })}
        </p>
      ) : null}
      {uploading ? (
        <p className="text-sm" role="status">
          {format(text.uploading, { name: uploading })}
        </p>
      ) : null}
    </>
  )
}
