"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { useRunAction } from "@/components/gantry/use-action"
import { errorOf, type UploadConflicts } from "@/components/gantry/use-file-browser"
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
import { Textarea } from "@/components/ui/textarea"
import { splitFilePath, uploadUrl } from "@/lib/files/browser"
import type { FileEntry } from "@/lib/files/entries"
import { joinPath } from "@/lib/files/paths"
import { useI18n } from "@/lib/i18n/client"
import type { ActionState } from "@/lib/validation"

// Dialogs of the file browser (components/gantry/file-browser.tsx).

export function NewFolderDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (name: string) => Promise<ActionState>
}) {
  const { t } = useI18n()
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
            <DialogTitle>{t.files.newFolder}</DialogTitle>
            <DialogDescription>{t.files.newFolderDescription}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>{t.files.folderName}</FieldLabel>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              {t.common.actions.cancel}
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? t.files.creating : t.common.actions.create}
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

export function EditFileDialog({
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
  const i18n = useI18n()
  const { t, format } = i18n
  const text = t.files
  const openFailed = text.errors.openFailed
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
        if (!res.ok) return setError((await errorOf(res, openFailed)).message)
        const data = (await res.json()) as ReadResult
        if (cancelled) return
        setFile(data)
        if (data.ok) setContent(data.content)
      })
      .catch(() => !cancelled && setError(openFailed))
    return () => {
      cancelled = true
    }
  }, [query, filePath, router, openFailed])

  const bytes = React.useMemo(() => new TextEncoder().encode(content).length, [content])
  const dirty = file?.ok === true && content !== file.content
  const tooBig = bytes > limit

  async function save() {
    // Save where the file really is: uploads never replace a symbolic link.
    const { dir: target, name } = splitFilePath(filePath)
    setSaving(true)
    try {
      const res = await fetch(uploadUrl(query, target, name, { edit: true, overwrite: true, environmentId }), {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Blob([content]),
      })
      if (!res.ok) {
        toast.error((await errorOf(res, text.errors.saveFailed)).message)
        return
      }
      toast.success(format(text.saved, { name }))
      onClose(true)
    } catch {
      toast.error(text.errors.saveConnection)
    } finally {
      setSaving(false)
    }
  }

  const reason =
    file && !file.ok
      ? file.reason === "binary"
        ? text.binary
        : file.reason === "too-large"
          ? format(text.tooLarge, { size: i18n.formatBytes(file.size), limit: i18n.formatBytes(file.limit) })
          : text.notAFile
      : null

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose(false)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{filePath}</DialogTitle>
          <DialogDescription>
            {canWrite ? format(text.editHelp, { limit: i18n.formatBytes(limit) }) : text.readOnly}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : !file ? (
          <p className="text-sm text-muted-foreground">{t.common.status.loading}</p>
        ) : reason ? (
          <p className="text-sm text-muted-foreground" role="status">
            {reason}
          </p>
        ) : (
          <Field>
            <FieldLabel htmlFor={`${id}-content`}>{text.fileContent}</FieldLabel>
            <Textarea
              id={`${id}-content`}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              readOnly={!canWrite}
              spellCheck={false}
              className="h-[24rem] resize-y font-mono text-xs"
            />
            <FieldDescription className={tooBig ? "text-destructive" : undefined}>
              {i18n.formatBytes(bytes)}
              {tooBig ? format(text.overLimit, { limit: i18n.formatBytes(limit) }) : ""}
            </FieldDescription>
          </Field>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onClose(false)} disabled={saving}>
            {t.common.actions.close}
          </Button>
          {canWrite && file?.ok ? (
            <Button onClick={() => guardWrite(() => void save())} disabled={saving || !dirty || tooBig}>
              {saving ? t.common.status.saving : t.common.actions.save}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Some of the files dropped or chosen already exist: skip or replace them. */
export function UploadConflictDialog({
  conflicts,
  onSkip,
  onReplace,
  onDismiss,
}: {
  conflicts: UploadConflicts | null
  onSkip: () => void
  onReplace: () => void
  onDismiss: () => void
}) {
  const { t, format } = useI18n()
  const text = t.files
  return (
    <AlertDialog open={conflicts !== null} onOpenChange={(o) => !o && onDismiss()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{text.replaceTitle}</AlertDialogTitle>
          <AlertDialogDescription>
            {conflicts?.existing.length === 1
              ? format(text.existsOne, { name: conflicts.existing[0] })
              : format(text.existsMany, { count: String(conflicts?.existing.length), names: String(conflicts?.existing.join(", ")) })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t.common.actions.cancel}</AlertDialogCancel>
          <Button variant="outline" onClick={onSkip}>
            {text.skipExisting}
          </Button>
          <AlertDialogAction onClick={onReplace}>{text.replace}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Asked once before the first change when the target is in use (FileBrowser's `writeWarning`). */
export function WriteWarningDialog({
  open,
  warning,
  onContinue,
  onCancel,
}: {
  open: boolean
  warning: string | null | undefined
  onContinue: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.files.inUseTitle}</AlertDialogTitle>
          <AlertDialogDescription>{warning}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t.common.actions.cancel}</AlertDialogCancel>
          <AlertDialogAction onClick={onContinue}>{t.common.actions.continue}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
