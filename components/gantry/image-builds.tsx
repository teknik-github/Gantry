"use client"

import * as React from "react"
import Link from "next/link"
import { RotateCcwIcon, ScrollTextIcon } from "lucide-react"

import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useI18n } from "@/lib/i18n/client"
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
  const { t } = useI18n()
  return (
    <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground capitalize">
      <span className={cn("size-2 rounded-full", STATUS_STYLES[status])} />
      {t.images.builds.statuses[status]}
    </Badge>
  )
}

/** Recent builds of this environment: open the log, or prefill the form for a rebuild. */
export function ImageBuildHistory({ builds }: { builds: BuildHistoryRow[] }) {
  const i18n = useI18n()
  const text = i18n.t.images.builds
  const [open, setOpen] = React.useState<BuildHistoryRow | null>(null)
  if (!builds.length) return <p className="text-sm text-muted-foreground">{text.none}</p>
  return (
    <>
      <div className="overflow-hidden rounded-lg border">
        <Table aria-label={i18n.t.images.build.recentBuilds}>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>{text.build}</TableHead>
              <TableHead>{text.status}</TableHead>
              <TableHead>{text.tags}</TableHead>
              <TableHead className="hidden @3xl/main:table-cell">{text.source}</TableHead>
              <TableHead className="hidden @xl/main:table-cell">{text.started}</TableHead>
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
                    {b.tags.map((tag) => (
                      <Mono key={tag} className="rounded bg-muted px-1.5 py-0.5">
                        {tag}
                      </Mono>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="hidden max-w-96 truncate text-muted-foreground @3xl/main:table-cell" title={b.sourceSummary}>
                  {b.sourceSummary}
                </TableCell>
                <TableCell className="hidden text-muted-foreground @xl/main:table-cell">
                  {i18n.format(text.startedBy, { when: b.startedLabel, user: b.username })}
                  {b.duration ? ` · ${b.duration}` : ""}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setOpen(b)} aria-label={i18n.format(text.logOf, { id: b.id })}>
                      <ScrollTextIcon data-icon="inline-start" />
                      {text.log}
                    </Button>
                    {b.sourceKind !== "upload" ? (
                      <Button asChild variant="ghost" size="sm">
                        <Link href={`/images/build?from=${b.id}`} aria-label={i18n.format(text.rebuildOf, { id: b.id })}>
                          <RotateCcwIcon data-icon="inline-start" />
                          {text.rebuild}
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
  const i18n = useI18n()
  const { t, format } = i18n
  const text = t.images.builds
  const [log, setLog] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    let alive = true
    fetch(`/api/images/builds/${build.id}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (!alive) return
        if (!res.ok) setError(body?.error ?? format(text.loadFailedStatus, { status: res.status }))
        else setLog(typeof body?.log === "string" ? body.log : "")
      })
      .catch(() => alive && setError(text.loadFailed))
    return () => {
      alive = false
    }
  }, [build.id, text, format])

  return (
    <>
      <DialogHeader>
        <DialogTitle>{format(text.title, { id: build.id })}</DialogTitle>
        <DialogDescription>
          {build.sourceSummary} · {format(text.startedBy, { when: build.startedLabel, user: build.username })}
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
          aria-label={format(text.logOf, { id: build.id })}
          className="max-h-[60vh] min-h-40 overflow-auto rounded-lg border bg-dock p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-slate-200"
        >
          {log === null ? t.common.status.loading : log || text.noOutput}
        </pre>
      )}
    </>
  )
}
