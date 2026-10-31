"use client"

import * as React from "react"
import Link from "next/link"
import { RotateCcwIcon, ScrollTextIcon } from "lucide-react"

import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

/** A history entry as rendered (see lib/server/images/builds.ts). */
export type BuildHistoryRow = {
  id: number
  username: string
  sourceKind: "editor" | "git" | "upload"
  sourceSummary: string
  tags: string[]
  status: "running" | "success" | "error" | "cancelled" | "interrupted"
  error: string | null
  imageId: string | null
  startedLabel: string
  duration: string | null
}

const STATUS_STYLES: Record<BuildHistoryRow["status"], string> = {
  running: "bg-crane",
  success: "bg-sea",
  error: "bg-destructive",
  cancelled: "bg-muted-foreground",
  interrupted: "bg-rust",
}

export function BuildStatusBadge({ status }: { status: BuildHistoryRow["status"] }) {
  return (
    <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground capitalize">
      <span className={cn("size-2 rounded-full", STATUS_STYLES[status])} />
      {status}
    </Badge>
  )
}

/** Recent builds of this environment: open the log, or prefill the form for a rebuild. */
export function ImageBuildHistory({ builds }: { builds: BuildHistoryRow[] }) {
  const [open, setOpen] = React.useState<BuildHistoryRow | null>(null)
  if (!builds.length) return <p className="text-sm text-muted-foreground">No builds yet.</p>
  return (
    <>
      <div className="overflow-hidden rounded-lg border">
        <Table aria-label="Recent builds">
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>Build</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead className="hidden @3xl/main:table-cell">Source</TableHead>
              <TableHead className="hidden @xl/main:table-cell">Started</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {builds.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="text-muted-foreground tabular-nums">#{b.id}</TableCell>
                <TableCell>
                  <BuildStatusBadge status={b.status} />
                </TableCell>
                <TableCell>
                  <div className="flex max-w-80 flex-wrap gap-1">
                    {b.tags.map((t) => (
                      <Mono key={t} className="rounded bg-muted px-1.5 py-0.5">
                        {t}
                      </Mono>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="hidden max-w-96 truncate text-muted-foreground @3xl/main:table-cell" title={b.sourceSummary}>
                  {b.sourceSummary}
                </TableCell>
                <TableCell className="hidden text-muted-foreground @xl/main:table-cell">
                  {b.startedLabel} by {b.username}
                  {b.duration ? ` · ${b.duration}` : ""}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setOpen(b)} aria-label={`Log of build #${b.id}`}>
                      <ScrollTextIcon data-icon="inline-start" />
                      Log
                    </Button>
                    {b.sourceKind !== "upload" ? (
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/images/build?from=${b.id}`} aria-label={`Rebuild build #${b.id}`}>
                          <RotateCcwIcon data-icon="inline-start" />
                          Rebuild
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-4xl">
          {open ? <BuildLogDialogBody build={open} /> : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

function BuildLogDialogBody({ build }: { build: BuildHistoryRow }) {
  const [log, setLog] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    let alive = true
    fetch(`/api/images/builds/${build.id}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (!alive) return
        if (!res.ok) setError(body?.error ?? `Could not load the log (${res.status})`)
        else setLog(typeof body?.log === "string" ? body.log : "")
      })
      .catch(() => alive && setError("Could not load the log"))
    return () => {
      alive = false
    }
  }, [build.id])

  return (
    <>
      <DialogHeader>
        <DialogTitle>Build #{build.id}</DialogTitle>
        <DialogDescription>
          {build.sourceSummary} · {build.startedLabel} by {build.username}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <BuildStatusBadge status={build.status} />
        {build.imageId ? <Mono className="text-muted-foreground">{build.imageId}</Mono> : null}
      </div>
      {build.error ? <p className="text-sm break-words text-destructive">{build.error}</p> : null}
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <pre
          role="log"
          aria-label={`Log of build #${build.id}`}
          className="max-h-[60vh] min-h-40 overflow-auto rounded-lg border bg-dock p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-slate-200"
        >
          {log === null ? "Loading…" : log || "No output."}
        </pre>
      )}
    </>
  )
}
