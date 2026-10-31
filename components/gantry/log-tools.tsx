"use client"

import * as React from "react"
import { ChevronDownIcon, ChevronUpIcon, DownloadIcon, SearchIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/lib/i18n/client"
import { lineSegments, localDateTimeToUnix, logDownloadUrl, searchLog, stepMatch } from "@/lib/log-search"
import { cn } from "@/lib/utils"

/**
 * Log output with search: case-insensitive filter/highlight, match count,
 * next/previous (Enter / Shift+Enter) and "only matching lines". Follows the
 * end of the log while auto-refresh is on and nothing is searched.
 */
export function LogOutput({ logs, follow }: { logs: string; follow: boolean }) {
  const { t, format } = useI18n()
  const text = t.containers.logs
  const id = React.useId()
  const [query, setQuery] = React.useState("")
  const [onlyMatching, setOnlyMatching] = React.useState(false)
  const [current, setCurrent] = React.useState(0)
  const preRef = React.useRef<HTMLPreElement>(null)
  const currentRef = React.useRef<HTMLElement | null>(null)
  const [scrollKey, setScrollKey] = React.useState(0)

  const search = React.useMemo(() => searchLog(logs, query), [logs, query])
  const count = search.matches.length
  // Refreshed logs may have fewer matches than before.
  const active = count ? Math.min(current, count - 1) : -1
  const activeMatch = active >= 0 ? search.matches[active] : null

  const step = (direction: 1 | -1) => {
    setCurrent(stepMatch(active, count, direction))
    setScrollKey((k) => k + 1)
  }

  React.useEffect(() => {
    const el = preRef.current
    if (el && follow && !query) el.scrollTop = el.scrollHeight
  }, [logs, follow, query])

  React.useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "center", inline: "nearest" })
  }, [scrollKey, query])

  const shown = onlyMatching && query ? search.matchingLines : search.lines.map((_, i) => i)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <label htmlFor={`${id}-search`} className="sr-only">
            {text.search}
          </label>
          <Input
            id={`${id}-search`}
            type="search"
            value={query}
            placeholder={text.searchPlaceholder}
            className="h-7 w-64 pl-7 text-xs"
            onChange={(e) => {
              setQuery(e.target.value)
              setCurrent(0)
              setScrollKey((k) => k + 1)
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return
              e.preventDefault()
              step(e.shiftKey ? -1 : 1)
            }}
          />
        </div>
        <span className="min-w-20 text-xs text-muted-foreground tabular-nums" data-testid="log-match-count" aria-live="polite">
          {query
            ? count
              ? `${format(text.matchOf, { current: active + 1, count })}${search.capped ? "+" : ""}`
              : text.noMatches
            : ""}
        </span>
        <Button size="icon-sm" variant="outline" disabled={!count} onClick={() => step(-1)} aria-label={text.previousMatch}>
          <ChevronUpIcon />
        </Button>
        <Button size="icon-sm" variant="outline" disabled={!count} onClick={() => step(1)} aria-label={text.nextMatch}>
          <ChevronDownIcon />
        </Button>
        <Label className="font-normal">
          <Switch checked={onlyMatching} onCheckedChange={setOnlyMatching} />
          {text.onlyMatching}
        </Label>
      </div>
      <pre
        ref={preRef}
        data-testid="log-output"
        className="h-[28rem] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
      >
        {search.lines.length === 0
          ? text.noOutput
          : shown.length === 0
            ? text.noMatchingLines
            : shown.map((i) => (
                <div key={i} data-line={i}>
                  {query
                    ? lineSegments(search.lines[i], query).map((seg) => {
                        if (!seg.match) return <React.Fragment key={seg.start}>{seg.text}</React.Fragment>
                        const isActive = activeMatch?.line === i && activeMatch.start === seg.start
                        return (
                          <mark
                            key={seg.start}
                            ref={isActive ? (el) => void (currentRef.current = el) : undefined}
                            data-active={isActive || undefined}
                            className={cn(
                              "rounded-sm px-px text-inherit",
                              isActive ? "bg-amber-400 dark:bg-amber-500" : "bg-amber-200/80 dark:bg-amber-700/60"
                            )}
                          >
                            {seg.text}
                          </mark>
                        )
                      })
                    : search.lines[i] || " "}
                </div>
              ))}
      </pre>
    </div>
  )
}

/** Download the full logs (streamed) as a .log file, with timestamps, since/until and tail options. */
export function LogDownloadDialog({ id }: { id: string }) {
  const { t } = useI18n()
  const text = t.containers.logs
  const uid = React.useId()
  const [open, setOpen] = React.useState(false)
  const [timestamps, setTimestamps] = React.useState(true)
  const [since, setSince] = React.useState("")
  const [until, setUntil] = React.useState("")
  const [tail, setTail] = React.useState("")

  const sinceTs = localDateTimeToUnix(since)
  const untilTs = localDateTimeToUnix(until)
  const tailValid = tail === "" || (/^\d+$/.test(tail) && Number(tail) > 0)
  const rangeValid = sinceTs === undefined || untilTs === undefined || untilTs > sinceTs
  const href = logDownloadUrl(id, { timestamps, since: sinceTs, until: untilTs, tail: tail === "" ? "all" : tail })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <DownloadIcon data-icon="inline-start" />
          {t.common.actions.download}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{text.downloadTitle}</DialogTitle>
          <DialogDescription>{text.downloadDescription}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field orientation="horizontal">
            <Checkbox id={`${uid}-ts`} checked={timestamps} onCheckedChange={(v) => setTimestamps(v === true)} />
            <FieldLabel htmlFor={`${uid}-ts`} className="font-normal">
              {text.includeTimestamps}
            </FieldLabel>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${uid}-since`}>{text.since}</FieldLabel>
              <Input id={`${uid}-since`} type="datetime-local" step="1" value={since} onChange={(e) => setSince(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${uid}-until`}>{text.until}</FieldLabel>
              <Input id={`${uid}-until`} type="datetime-local" step="1" value={until} onChange={(e) => setUntil(e.target.value)} />
            </Field>
          </div>
          {!rangeValid ? <p className="text-sm text-destructive">{text.rangeInvalid}</p> : null}
          <Field data-invalid={tailValid ? undefined : true}>
            <FieldLabel htmlFor={`${uid}-tail`}>{text.lastLinesLabel}</FieldLabel>
            <Input id={`${uid}-tail`} inputMode="numeric" placeholder={text.all} value={tail} onChange={(e) => setTail(e.target.value.trim())} />
            <FieldDescription>{tailValid ? text.tailHelp : text.tailInvalid}</FieldDescription>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t.common.actions.cancel}
          </Button>
          {tailValid && rangeValid ? (
            <Button asChild>
              <a href={href} download onClick={() => setOpen(false)}>
                <DownloadIcon data-icon="inline-start" />
                {text.downloadFile}
              </a>
            </Button>
          ) : (
            <Button disabled>
              <DownloadIcon data-icon="inline-start" />
              {text.downloadFile}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
