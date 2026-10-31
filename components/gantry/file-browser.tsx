"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  ArrowUpIcon,
  DownloadIcon,
  FileIcon,
  FileSymlinkIcon,
  FileTextIcon,
  FolderIcon,
  FolderPlusIcon,
  HardDriveIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react"
import { toast } from "sonner"

import { createFolderAction, deletePathAction } from "@/app/(app)/files/actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { useRunAction } from "@/components/gantry/use-action"
import { Mono } from "@/components/gantry/ui"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { formatMode, targetQuery, type FileEntry, type FileTarget, type Listing } from "@/lib/files/entries"
import { joinPath, normalizePath, parentPath, pathSegments, resolveLinkTarget } from "@/lib/files/paths"
import { formatBytes } from "@/lib/format"
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

type ApiError = { error?: string; code?: string }

async function errorOf(res: Response, fallback: string) {
  const body = (await res.json().catch(() => ({}))) as ApiError
  return { message: body.error ?? fallback, code: body.code }
}

function formatTime(seconds: number) {
  if (!seconds) return "—"
  return new Date(seconds * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
}

function owner(e: FileEntry) {
  return `${e.user ?? e.uid}:${e.group ?? e.gid}`
}

/** Upload one file with progress (XHR: fetch has no upload progress). */
function putFile(url: string, file: Blob, onProgress: (fraction: number) => void): Promise<{ ok: boolean; status: number; body: ApiError }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url)
    xhr.setRequestHeader("Content-Type", "application/octet-stream")
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total)
    }
    xhr.onload = () => {
      let body: ApiError = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch {}
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body })
    }
    xhr.onerror = () => resolve({ ok: false, status: 0, body: { error: "Upload failed. Check your connection." } })
    xhr.send(file)
  })
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
  const router = useRouter()
  const environmentId = useEnvironmentId()
  const inputId = React.useId()
  const [listing, setListing] = React.useState<Listing | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  // Set when a navigation starts, cleared when its listing arrives.
  const [loading, setLoading] = React.useState(true)
  const [pathInput, setPathInput] = React.useState(initialPath)
  const [dragging, setDragging] = React.useState(false)
  const [uploading, setUploading] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState<FileEntry | null>(null)
  const [newFolderOpen, setNewFolderOpen] = React.useState(false)
  const [conflicts, setConflicts] = React.useState<{ files: File[]; existing: string[] } | null>(null)
  const [warnAck, setWarnAck] = React.useState(false)
  const [pendingWrite, setPendingWrite] = React.useState<(() => void) | null>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)
  /** The user is typing a path: a listing arriving meanwhile must not overwrite it. */
  const typingRef = React.useRef(false)

  const query = React.useMemo(() => targetQuery(target).toString(), [target])
  const path = listing?.path ?? normalizePath(initialPath)

  // Each navigation is a request; the effect below fetches it (and aborts the previous one).
  const [request, setRequest] = React.useState({ path: normalizePath(initialPath), keepOnError: false, n: 0 })

  React.useEffect(() => {
    const controller = new AbortController()
    const { path: next, keepOnError } = request
    const fail = (message: string) => (keepOnError ? toast.error(message) : setError(message))
    fetch(`/api/files/list?${query}&path=${encodeURIComponent(next)}`, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (res.status === 401) return router.replace("/login")
        if (!res.ok) return fail((await errorOf(res, "Failed to list files")).message)
        const data = (await res.json()) as Listing
        setListing(data)
        if (!typingRef.current) setPathInput(data.path)
        setError(null)
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") fail("Failed to list files")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [request, query, router])

  const navigate = (next: string) => {
    typingRef.current = false
    setLoading(true)
    setRequest((r) => ({ path: next, keepOnError: listing !== null, n: r.n + 1 }))
  }
  const reload = () => navigate(path)

  /** Runs a change, asking once to confirm `writeWarning` first. */
  const guardWrite = (fn: () => void) => {
    if (writeWarning && !warnAck) setPendingWrite(() => fn)
    else fn()
  }

  const linkPath = (e: FileEntry) => {
    if (e.type !== "symlink" || !e.linkTarget) return null
    // In a volume, absolute links point into whatever container mounts it: not followable.
    if (target.kind === "volume" && e.linkTarget.startsWith("/")) return null
    return resolveLinkTarget(path, e.linkTarget)
  }

  const downloadUrl = (p: string) => `/api/files/download?${query}&path=${encodeURIComponent(p)}`

  async function uploadFiles(files: File[], overwrite: Set<string>) {
    let done = 0
    for (const file of files) {
      if (file.size > limits.uploadMaxBytes) {
        toast.error(`${file.name} is larger than the upload limit (${formatBytes(limits.uploadMaxBytes)})`)
        continue
      }
      const params = new URLSearchParams(query)
      params.set("path", path)
      params.set("name", file.name)
      if (overwrite.has(file.name)) params.set("overwrite", "1")
      if (environmentId !== undefined) params.set("env", String(environmentId))
      setUploading(`${file.name} (0%)`)
      const res = await putFile(`/api/uploads/files?${params}`, file, (f) => setUploading(`${file.name} (${Math.round(f * 100)}%)`))
      if (res.ok) done++
      else toast.error(`${file.name}: ${res.body.error ?? `upload failed (${res.status})`}`)
    }
    setUploading(null)
    if (done) toast.success(done === 1 ? `Uploaded ${files.length === 1 ? files[0].name : "1 file"}` : `Uploaded ${done} files`)
    reload()
  }

  function startUpload(list: FileList | File[] | null) {
    const files = [...(list ?? [])]
    if (!files.length || !canWrite) return
    guardWrite(() => {
      const names = new Set(listing?.entries.map((e) => e.name))
      const existing = files.filter((f) => names.has(f.name)).map((f) => f.name)
      if (existing.length) setConflicts({ files, existing })
      else void uploadFiles(files, new Set())
    })
  }

  const segments = pathSegments(path)
  const busy = loading || uploading !== null

  return (
    <Card
      data-testid="file-browser"
      className={cn(dragging && "ring-2 ring-primary")}
      onDragOver={(e) => {
        if (!canWrite || !e.dataTransfer.types.includes("Files")) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDragging(false)
      }}
      onDrop={(e) => {
        if (!canWrite) return
        e.preventDefault()
        setDragging(false)
        startUpload(e.dataTransfer.files)
      }}
    >
      <CardHeader>
        <CardTitle>Files</CardTitle>
        <CardDescription>
          {canWrite ? "Browse, download, upload (or drop files here), edit and delete." : "Browse and download."}
        </CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          <Button size="icon-sm" variant="outline" onClick={reload} disabled={loading} aria-label="Refresh files">
            <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a href={downloadUrl(path)} download aria-label="Download folder as tar">
              <DownloadIcon data-icon="inline-start" />
              Download folder
            </a>
          </Button>
          {canWrite ? (
            <>
              <Button size="sm" variant="outline" onClick={() => guardWrite(() => setNewFolderOpen(true))} disabled={busy}>
                <FolderPlusIcon data-icon="inline-start" />
                New folder
              </Button>
              <Button size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
                <UploadIcon data-icon="inline-start" />
                Upload
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                aria-label="Files to upload"
                onChange={(e) => {
                  startUpload(e.currentTarget.files)
                  e.currentTarget.value = ""
                }}
              />
            </>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
            <Button variant="ghost" size="xs" onClick={() => navigate("/")} aria-label={`${rootLabel} (root)`}>
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
              Go to path
            </label>
            <Input
              id={`${inputId}-path`}
              value={pathInput}
              onChange={(e) => {
                typingRef.current = true
                setPathInput(e.target.value)
              }}
              className="h-7 w-56 font-mono text-xs"
            />
            <Button size="sm" variant="outline" type="submit">
              Go
            </Button>
          </form>
        </div>

        {listing?.source === "archive" ? (
          <p className="text-xs text-muted-foreground" data-testid="files-archive-note">
            Listed from Docker&apos;s archive of this folder (the container isn&apos;t running or has no shell). Large folders take
            longer.
          </p>
        ) : null}
        {listing?.truncated ? (
          <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <TriangleAlertIcon className="size-3.5" />
            {listing.truncated}
          </p>
        ) : null}
        {canWrite && deleteBlocker ? (
          <p className="text-xs text-muted-foreground" data-testid="files-delete-blocker">
            Delete unavailable: {deleteBlocker}
          </p>
        ) : null}
        {uploading ? (
          <p className="text-sm" role="status">
            Uploading {uploading}…
          </p>
        ) : null}

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : !listing ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="rounded-lg border">
            <Table aria-label="Files">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Modified</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {path !== "/" ? (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <Button variant="ghost" size="xs" onClick={() => navigate(parentPath(path))} aria-label="Parent folder">
                        <ArrowUpIcon data-icon="inline-start" />
                        ..
                      </Button>
                    </TableCell>
                  </TableRow>
                ) : null}
                {listing.entries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-muted-foreground">
                      Empty folder.
                    </TableCell>
                  </TableRow>
                ) : null}
                {listing.entries.map((e) => (
                  <EntryRow
                    key={e.name}
                    entry={e}
                    path={joinPath(path, e.name)}
                    linkPath={linkPath(e)}
                    canWrite={canWrite}
                    deleteBlocker={deleteBlocker ?? null}
                    downloadUrl={downloadUrl}
                    onOpen={navigate}
                    onEdit={() => setEditing(e)}
                    onDelete={() =>
                      deletePathAction(target, joinPath(path, e.name), environmentId).then((res) => {
                        if (res.ok) reload()
                        return res
                      })
                    }
                    guardWrite={guardWrite}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <NewFolderDialog
        open={newFolderOpen}
        onOpenChange={setNewFolderOpen}
        onCreate={(name) =>
          createFolderAction(target, path, name, environmentId).then((res) => {
            if (res.ok) reload()
            return res
          })
        }
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

      <AlertDialog open={conflicts !== null} onOpenChange={(o) => !o && setConflicts(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace existing files?</AlertDialogTitle>
            <AlertDialogDescription>
              {conflicts?.existing.length === 1
                ? `${conflicts.existing[0]} already exists in this folder.`
                : `${conflicts?.existing.length} files already exist in this folder: ${conflicts?.existing.join(", ")}.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                const c = conflicts!
                setConflicts(null)
                const skip = new Set(c.existing)
                const rest = c.files.filter((f) => !skip.has(f.name))
                if (rest.length) void uploadFiles(rest, new Set())
              }}
            >
              Skip existing
            </Button>
            <AlertDialogAction
              onClick={() => {
                const c = conflicts!
                setConflicts(null)
                void uploadFiles(c.files, new Set(c.existing))
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={pendingWrite !== null} onOpenChange={(o) => !o && setPendingWrite(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change files in use?</AlertDialogTitle>
            <AlertDialogDescription>{writeWarning}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const fn = pendingWrite
                setPendingWrite(null)
                setWarnAck(true)
                fn?.()
              }}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
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
}: {
  entry: FileEntry
  path: string
  linkPath: string | null
  canWrite: boolean
  deleteBlocker: string | null
  downloadUrl: (path: string) => string
  onOpen: (path: string) => void
  onEdit: () => void
  onDelete: () => Promise<ActionState>
  guardWrite: (fn: () => void) => void
}) {
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const Icon = e.type === "dir" ? FolderIcon : e.type === "symlink" ? FileSymlinkIcon : FileIcon
  const openable = e.type === "dir" || (e.type === "symlink" && linkPath !== null)
  const fileLike = e.type === "file" || (e.type === "symlink" && linkPath !== null)
  const readPath = e.type === "symlink" ? linkPath : path
  const typeLabel = e.type === "other" ? (e.kind ?? "other") : e.kind === "hardlink" ? "hard link" : e.type === "dir" ? "folder" : e.type

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
              aria-label={`Open ${e.name}`}
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
      <TableCell className="text-muted-foreground">{typeLabel}</TableCell>
      <TableCell className="text-right tabular-nums">{e.type === "file" ? formatBytes(e.size) : "—"}</TableCell>
      <TableCell>
        <Mono>{formatMode(e)}</Mono>
      </TableCell>
      <TableCell>
        <Mono>{owner(e)}</Mono>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">{formatTime(e.mtime)}</TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {fileLike ? (
            <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`${canWrite ? "Edit" : "View"} ${e.name}`}>
              <FileTextIcon />
            </Button>
          ) : null}
          {readPath && e.type !== "other" ? (
            <Button variant="ghost" size="icon-sm" asChild>
              <a href={downloadUrl(readPath)} download aria-label={`Download ${e.name}`}>
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
                aria-label={`Delete ${e.name}`}
                onClick={() => guardWrite(() => setConfirmOpen(true))}
              >
                <Trash2Icon />
              </Button>
              <ConfirmAction
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title={`Delete ${e.name}?`}
                description={
                  e.type === "dir" ? `The folder ${path} and everything in it will be deleted.` : `${path} will be deleted.`
                }
                confirmLabel="Delete"
                onConfirm={onDelete}
              />
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  )
}

function NewFolderDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (name: string) => Promise<ActionState>
}) {
  const id = React.useId()
  const [name, setName] = React.useState("")
  const [pending, run] = useRunAction()
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return
        onOpenChange(o)
        if (o) setName("")
      }}
    >
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await run(() => onCreate(name.trim()))) {
              onOpenChange(false)
              setName("")
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>Created in the current folder, owned by root (mode 755).</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>Folder name</FieldLabel>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type ReadResult =
  | { ok: true; content: string; size: number; mode: number; limit: number }
  | { ok: false; reason: "binary" | "too-large" | "not-a-file"; size: number; limit: number }

function EditFileDialog({
  query,
  dir,
  entry,
  linkPath,
  canWrite,
  limit,
  guardWrite,
  onClose,
}: {
  query: string
  dir: string
  entry: FileEntry
  linkPath: string | null
  canWrite: boolean
  limit: number
  guardWrite: (fn: () => void) => void
  onClose: (saved: boolean) => void
}) {
  const id = React.useId()
  const router = useRouter()
  const environmentId = useEnvironmentId()
  const filePath = entry.type === "symlink" && linkPath ? linkPath : joinPath(dir, entry.name)
  const [file, setFile] = React.useState<ReadResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [content, setContent] = React.useState("")
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    fetch(`/api/files/read?${query}&path=${encodeURIComponent(filePath)}`, { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return
        if (res.status === 401) return router.replace("/login")
        if (!res.ok) return setError((await errorOf(res, "Failed to open the file")).message)
        const data = (await res.json()) as ReadResult
        if (cancelled) return
        setFile(data)
        if (data.ok) setContent(data.content)
      })
      .catch(() => !cancelled && setError("Failed to open the file"))
    return () => {
      cancelled = true
    }
  }, [query, filePath, router])

  const bytes = React.useMemo(() => new TextEncoder().encode(content).length, [content])
  const dirty = file?.ok === true && content !== file.content
  const tooBig = bytes > limit

  async function save() {
    // Save where the file really is: uploads never replace a symbolic link.
    const target = parentPath(filePath)
    const name = filePath.slice(target === "/" ? 1 : target.length + 1)
    const params = new URLSearchParams(query)
    params.set("path", target)
    params.set("name", name)
    params.set("mode", "edit")
    params.set("overwrite", "1")
    if (environmentId !== undefined) params.set("env", String(environmentId))
    setSaving(true)
    try {
      const res = await fetch(`/api/uploads/files?${params}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([content]),
      })
      if (!res.ok) {
        toast.error((await errorOf(res, "Save failed")).message)
        return
      }
      toast.success(`Saved ${name}`)
      onClose(true)
    } catch {
      toast.error("Save failed. Check your connection.")
    } finally {
      setSaving(false)
    }
  }

  const reason =
    file && !file.ok
      ? file.reason === "binary"
        ? "This looks like a binary file; download it instead."
        : file.reason === "too-large"
          ? `This file (${formatBytes(file.size)}) is larger than the editor limit of ${formatBytes(file.limit)}; download it instead.`
          : "Only regular files can be opened."
      : null

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose(false)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{filePath}</DialogTitle>
          <DialogDescription>
            {canWrite ? `Text files up to ${formatBytes(limit)}; saving keeps the owner and mode.` : "Read-only: editing needs the manager role."}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : !file ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : reason ? (
          <p className="text-sm text-muted-foreground" role="status">
            {reason}
          </p>
        ) : (
          <Field>
            <FieldLabel htmlFor={`${id}-content`}>File content</FieldLabel>
            <Textarea
              id={`${id}-content`}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              readOnly={!canWrite}
              spellCheck={false}
              className="h-[24rem] resize-y font-mono text-xs"
            />
            <FieldDescription className={tooBig ? "text-destructive" : undefined}>
              {formatBytes(bytes)}
              {tooBig ? ` — larger than the limit of ${formatBytes(limit)}` : ""}
            </FieldDescription>
          </Field>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} disabled={saving}>
            Close
          </Button>
          {canWrite && file?.ok ? (
            <Button onClick={() => guardWrite(() => void save())} disabled={saving || !dirty || tooBig}>
              {saving ? "Saving…" : "Save"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
