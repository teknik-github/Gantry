"use client"

import * as React from "react"
import { CircleCheckIcon, CircleXIcon, LoaderCircleIcon } from "lucide-react"
import { toast } from "sonner"

import type { HelmOperationEvent, HelmOperationInfo } from "@/lib/server/kubernetes/helm-operations"
import { cn } from "@/lib/utils"

/** Kept in the browser; older output scrolls away. */
const MAX_CHARS = 512 * 1024

type Status = "running" | "succeeded" | "failed"

/**
 * Live output of a Helm operation (install/upgrade/rollback): follows
 * /api/kubernetes/helm/operations/<id> until the command ends. The output
 * was redacted on the server.
 */
export function HelmOperationLog({
  operation,
  onDone,
}: {
  operation: HelmOperationInfo
  onDone?: (ok: boolean, message: string) => void
}) {
  const [output, setOutput] = React.useState("")
  const [status, setStatus] = React.useState<Status>("running")
  const [message, setMessage] = React.useState("")
  const preRef = React.useRef<HTMLPreElement>(null)
  const onDoneRef = React.useRef(onDone)
  React.useEffect(() => {
    onDoneRef.current = onDone
  })

  React.useEffect(() => {
    const abort = new AbortController()
    let text = ""
    let finished = false
    const finish = (ok: boolean, msg: string) => {
      if (finished) return
      finished = true
      setStatus(ok ? "succeeded" : "failed")
      setMessage(msg)
      if (ok) toast.success(msg)
      else toast.error(msg)
      onDoneRef.current?.(ok, msg)
    }
    ;(async () => {
      try {
        const res = await fetch(`/api/kubernetes/helm/operations/${encodeURIComponent(operation.id)}`, {
          signal: abort.signal,
          cache: "no-store",
        })
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null
          finish(false, body?.error ?? `Could not follow the operation (${res.status})`)
          return
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
        let pending = ""
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          pending += value
          let nl: number
          while ((nl = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, nl)
            pending = pending.slice(nl + 1)
            if (!line.trim()) continue
            const event = JSON.parse(line) as HelmOperationEvent
            if (event.type === "output") {
              text = (text + event.text).slice(-MAX_CHARS)
              setOutput(text)
            } else finish(event.ok, event.message)
          }
        }
        if (!finished) finish(false, "The connection to the server was lost; the operation may still be running. Reload the page to see the release.")
      } catch (err) {
        if (abort.signal.aborted) return
        finish(false, `Could not follow the operation: ${(err as Error).message}`)
      }
    })()
    return () => abort.abort()
  }, [operation.id])

  React.useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])

  return (
    <div className="flex flex-col gap-2" data-testid="helm-operation" data-state={status}>
      <div className="flex items-center gap-2 text-sm" role="status">
        {status === "running" ? (
          <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />
        ) : status === "succeeded" ? (
          <CircleCheckIcon className="size-4 text-sea" />
        ) : (
          <CircleXIcon className="size-4 text-destructive" />
        )}
        <span className={cn(status === "failed" && "text-destructive")}>
          {status === "running" ? `helm ${operation.kind} ${operation.release} is running…` : message}
        </span>
      </div>
      <pre
        ref={preRef}
        data-testid="helm-output"
        className="max-h-96 min-h-24 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
      >
        {output || " "}
      </pre>
    </div>
  )
}
