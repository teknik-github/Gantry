"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { useEnvironmentId } from "@/components/gantry/environment-scope"
import type { Listing } from "@/lib/files/entries"
import { existingNames, uploadUrl, withoutNames } from "@/lib/files/browser"
import { normalizePath } from "@/lib/files/paths"
import { useI18n } from "@/lib/i18n/client"

// State and requests of the file browser (components/gantry/file-browser.tsx).

type ApiError = { error?: string; code?: string }

export async function errorOf(res: Response, fallback: string) {
  const body = (await res.json().catch(() => ({}))) as ApiError
  return { message: body.error ?? fallback, code: body.code }
}

/** Upload one file with progress (XHR: fetch has no upload progress). */
function putFile(
  url: string,
  file: Blob,
  onProgress: (fraction: number) => void,
  connectionError: string
): Promise<{ ok: boolean; status: number; body: ApiError }> {
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
    xhr.onerror = () => resolve({ ok: false, status: 0, body: { error: connectionError } })
    xhr.send(file)
  })
}

/**
 * The folder shown and the path box. Each navigation is a request; an effect
 * fetches it (and aborts the previous one). Once a listing is shown, a
 * failed navigation keeps it and reports the error as a toast.
 */
export function useDirectoryListing(query: string, initialPath: string) {
  const listFailed = useI18n().t.files.errors.listFailed
  const router = useRouter()
  const [listing, setListing] = React.useState<Listing | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  // Set when a navigation starts, cleared when its listing arrives.
  const [loading, setLoading] = React.useState(true)
  const [pathInput, setPathInput] = React.useState(initialPath)
  /** The user is typing a path: a listing arriving meanwhile must not overwrite it. */
  const typingRef = React.useRef(false)

  const path = listing?.path ?? normalizePath(initialPath)

  const [request, setRequest] = React.useState({ path: normalizePath(initialPath), keepOnError: false, n: 0 })

  React.useEffect(() => {
    const controller = new AbortController()
    const { path: next, keepOnError } = request
    const fail = (message: string) => (keepOnError ? toast.error(message) : setError(message))
    fetch(`/api/files/list?${query}&path=${encodeURIComponent(next)}`, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (res.status === 401) return router.replace("/login")
        if (!res.ok) return fail((await errorOf(res, listFailed)).message)
        const data = (await res.json()) as Listing
        setListing(data)
        if (!typingRef.current) setPathInput(data.path)
        setError(null)
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") fail(listFailed)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [request, query, router, listFailed])

  const navigate = (next: string) => {
    typingRef.current = false
    setLoading(true)
    setRequest((r) => ({ path: next, keepOnError: listing !== null, n: r.n + 1 }))
  }
  const reload = () => navigate(path)
  const typePath = (value: string) => {
    typingRef.current = true
    setPathInput(value)
  }

  return { listing, error, loading, path, pathInput, typePath, navigate, reload }
}

/**
 * Runs a change, asking once to confirm `warning` first (e.g. a volume in
 * use). `pending` is true while that question is open.
 */
export function useWriteGuard(warning: string | null | undefined) {
  const [warnAck, setWarnAck] = React.useState(false)
  const [pendingWrite, setPendingWrite] = React.useState<(() => void) | null>(null)

  const guardWrite = (fn: () => void) => {
    if (warning && !warnAck) setPendingWrite(() => fn)
    else fn()
  }
  const confirm = () => {
    const fn = pendingWrite
    setPendingWrite(null)
    setWarnAck(true)
    fn?.()
  }
  const cancel = () => setPendingWrite(null)

  return { guardWrite, pending: pendingWrite !== null, confirm, cancel }
}

export type UploadConflicts = { files: File[]; existing: string[] }

/**
 * Uploads into the folder shown, one file at a time with progress
 * (`uploading`: "name (42%)"). Files that already exist there wait in
 * `conflicts` until the user skips or replaces them.
 */
export function useUploads({
  query,
  path,
  listing,
  canWrite,
  uploadMaxBytes,
  guardWrite,
  reload,
}: {
  query: string
  path: string
  listing: Listing | null
  canWrite: boolean
  uploadMaxBytes: number
  guardWrite: (fn: () => void) => void
  reload: () => void
}) {
  const i18n = useI18n()
  const { format } = i18n
  const text = i18n.t.files
  const environmentId = useEnvironmentId()
  const [uploading, setUploading] = React.useState<string | null>(null)
  const [conflicts, setConflicts] = React.useState<UploadConflicts | null>(null)

  async function uploadFiles(files: File[], overwrite: Set<string>) {
    let done = 0
    for (const file of files) {
      if (file.size > uploadMaxBytes) {
        toast.error(format(text.uploadTooLarge, { name: file.name, limit: i18n.formatBytes(uploadMaxBytes) }))
        continue
      }
      setUploading(`${file.name} (0%)`)
      const res = await putFile(
        uploadUrl(query, path, file.name, { overwrite: overwrite.has(file.name), environmentId }),
        file,
        (f) => setUploading(`${file.name} (${Math.round(f * 100)}%)`),
        text.errors.uploadConnection
      )
      if (res.ok) done++
      else toast.error(`${file.name}: ${res.body.error ?? format(text.uploadFailedStatus, { status: res.status })}`)
    }
    setUploading(null)
    if (done) {
      toast.success(
        done === 1 && files.length === 1 ? format(text.uploadedName, { name: files[0].name }) : i18n.plural(text.uploadedCount, done)
      )
    }
    reload()
  }

  function startUpload(list: FileList | File[] | null) {
    const files = [...(list ?? [])]
    if (!files.length || !canWrite) return
    guardWrite(() => {
      const existing = existingNames(files, listing?.entries)
      if (existing.length) setConflicts({ files, existing })
      else void uploadFiles(files, new Set())
    })
  }

  /** Uploads the files that don't exist yet. */
  function skipExisting() {
    const c = conflicts!
    setConflicts(null)
    const rest = withoutNames(c.files, c.existing)
    if (rest.length) void uploadFiles(rest, new Set())
  }

  /** Uploads every file, replacing those that exist. */
  function replaceExisting() {
    const c = conflicts!
    setConflicts(null)
    void uploadFiles(c.files, new Set(c.existing))
  }

  return { uploading, conflicts, startUpload, skipExisting, replaceExisting, dismissConflicts: () => setConflicts(null) }
}

/** Drag and drop of files onto the browser (managers only). */
export function useFileDrop(enabled: boolean, onDrop: (files: FileList) => void) {
  const [dragging, setDragging] = React.useState(false)
  const handlers = {
    onDragOver: (e: React.DragEvent) => {
      if (!enabled || !e.dataTransfer.types.includes("Files")) return
      e.preventDefault()
      setDragging(true)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      setDragging(false)
    },
    onDrop: (e: React.DragEvent) => {
      if (!enabled) return
      e.preventDefault()
      setDragging(false)
      onDrop(e.dataTransfer.files)
    },
  }
  return { dragging, handlers }
}
