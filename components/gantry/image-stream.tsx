"use client"

import * as React from "react"
import Link from "next/link"
import { CircleAlertIcon, CircleCheckIcon, CircleSlashIcon, LoaderIcon } from "lucide-react"

import { Mono } from "@/components/gantry/ui"
import { useI18n } from "@/lib/i18n/client"
import { JsonLineParser, type BuildStreamEvent, type DockerProgress, type FieldErrors } from "@/lib/image-build"
import { cn } from "@/lib/utils"

// Client side of the build/push streams (app/api/images/*): reads the JSON
// lines as they arrive, keeps the log and layer progress, and cancels by
// aborting the request (the server then stops the Docker build or push).

export type DoneEvent = Extract<BuildStreamEvent, { type: "done" }>
type Segment = { kind: "log" | "step"; text: string }

export type StreamState = {
  running: boolean
  buildId?: number
  segments: Segment[]
  progress: DockerProgress[]
  done?: DoneEvent
}

const EMPTY: StreamState = { running: false, segments: [], progress: [] }
/** Characters of log kept in the browser (the end). */
const MAX_LOG = 1024 * 1024

function appendSegment(segments: Segment[], kind: Segment["kind"], text: string) {
  const last = segments.at(-1)
  const next = last && last.kind === kind && kind === "log" ? [...segments.slice(0, -1), { kind, text: last.text + text }] : [...segments, { kind, text }]
  let size = next.reduce((n, s) => n + s.text.length, 0)
  while (size > MAX_LOG && next.length > 1) size -= next.shift()!.text.length
  return next
}

export function applyEvent(state: StreamState, event: BuildStreamEvent): StreamState {
  switch (event.type) {
    case "start":
      return { ...state, buildId: event.buildId }
    case "log":
      return { ...state, segments: appendSegment(state.segments, "log", event.text) }
    case "step":
      return { ...state, segments: appendSegment(state.segments, "step", event.text) }
    case "progress": {
      const rest = state.progress.filter((p) => p.id !== event.id)
      return { ...state, progress: [...rest, { id: event.id, status: event.status, progress: event.progress }].slice(-12) }
    }
    case "done":
      return { ...state, running: false, done: event, progress: [] }
  }
}

/** Request failed before streaming: the message and field errors to show. */
export type StartError = { error: string; fieldErrors?: FieldErrors }

/**
 * Runs one streamed request at a time. `start` resolves with an error when
 * the server refused it (validation, permissions) and with null once the
 * stream ended (state.done tells how).
 */
export function useImageStream() {
  const { t, format } = useI18n()
  const [state, setState] = React.useState<StreamState>(EMPTY)
  const abortRef = React.useRef<AbortController | null>(null)

  React.useEffect(() => () => abortRef.current?.abort(), [])

  const start = React.useCallback(async (url: string, init: RequestInit): Promise<StartError | null> => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setState({ ...EMPTY, running: true })
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: controller.signal })
    } catch {
      setState(EMPTY)
      return controller.signal.aborted ? null : { error: t.common.errors.requestFailed }
    }
    if (!res.ok || !res.body) {
      setState(EMPTY)
      const body = (await res.json().catch(() => null)) as StartError | null
      return { error: body?.error ?? format(t.images.stream.requestFailedStatus, { status: res.status }), fieldErrors: body?.fieldErrors }
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
    const parser = new JsonLineParser()
    let pending: BuildStreamEvent[] = []
    let frame = 0
    const flush = () => {
      frame = 0
      const events = pending
      pending = []
      setState((s) => events.reduce(applyEvent, s))
    }
    const queue = (events: unknown[]) => {
      for (const e of events) if (e && typeof e === "object" && "type" in e) pending.push(e as BuildStreamEvent)
      if (!frame) frame = window.setTimeout(flush, 50)
    }
    let sawDone = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const events = parser.push(value)
        if (events.some((e) => (e as BuildStreamEvent).type === "done")) sawDone = true
        queue(events)
      }
      const rest = parser.end()
      if (rest.some((e) => (e as BuildStreamEvent).type === "done")) sawDone = true
      queue(rest)
    } catch {
      // Aborted (Cancel) or the connection dropped.
    }
    if (frame) window.clearTimeout(frame)
    flush()
    if (!sawDone) {
      const cancelled = controller.signal.aborted
      setState((s) => ({
        ...s,
        running: false,
        progress: [],
        done: {
          type: "done",
          status: cancelled ? "cancelled" : "error",
          tags: [],
          pushed: [],
          error: cancelled ? t.images.stream.cancelled : t.images.stream.connectionLost,
        },
      }))
    }
    if (abortRef.current === controller) abortRef.current = null
    return null
  }, [t, format])

  const cancel = React.useCallback(() => abortRef.current?.abort(), [])
  const reset = React.useCallback(() => setState(EMPTY), [])
  return { state, start, cancel, reset }
}

/** Live output: Docker/git lines, Gantry's steps highlighted, layer progress below. */
export function StreamLog({ state, label, className }: { state: StreamState; label: string; className?: string }) {
  const { t } = useI18n()
  const ref = React.useRef<HTMLPreElement>(null)
  const stick = React.useRef(true)
  React.useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [state.segments])

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <pre
        ref={ref}
        role="log"
        aria-label={label}
        aria-live="off"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className="h-80 overflow-auto rounded-lg border bg-dock p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-slate-200"
      >
        {state.segments.length ? (
          state.segments.map((s, i) =>
            s.kind === "step" ? (
              <span key={i} className="block font-semibold text-crane">
                {"> "}
                {s.text}
              </span>
            ) : (
              <span key={i}>{s.text}</span>
            )
          )
        ) : (
          <span className="text-slate-400">{state.running ? t.images.stream.starting : t.images.stream.noOutput}</span>
        )}
      </pre>
      {state.progress.length ? (
        <ul className="grid gap-0.5 text-xs text-muted-foreground" aria-label={t.images.stream.layerProgress}>
          {state.progress.map((p) => (
            <li key={p.id} className="flex gap-2 font-mono">
              <span className="w-28 shrink-0 truncate">{p.id}</span>
              <span className="shrink-0">{p.status}</span>
              {p.progress ? <span className="truncate">{p.progress}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** Outcome banner: image id and tags, pushed digests, or the error (with a Registries link for login problems). */
export function StreamResult({ done, what }: { done: DoneEvent; what: "build" | "push" }) {
  const i18n = useI18n()
  const text = i18n.t.images.stream
  if (done.status === "success") {
    return (
      <div role="status" className="grid gap-2 rounded-lg border border-sea/40 bg-sea/12 p-3 text-sm" data-testid="stream-result">
        <p className="flex items-center gap-2 font-medium text-sea">
          <CircleCheckIcon className="size-4" />
          {what === "build" ? text.buildSucceeded : text.pushSucceeded}
        </p>
        {done.imageId ? (
          <p>
            {i18n.rich(text.image, { id: <Mono data-testid="built-image-id">{done.imageId}</Mono> })}
          </p>
        ) : null}
        {done.tags.length && what === "build" ? (
          <div className="flex flex-wrap items-center gap-1">
            {text.tagged}
            {done.tags.map((tag) => (
              <Link key={tag} href="/images" className="rounded bg-background px-1.5 py-0.5 font-mono text-xs underline-offset-4 hover:underline">
                {tag}
              </Link>
            ))}
          </div>
        ) : null}
        {done.pushed.length ? (
          <ul className="grid gap-0.5">
            {done.pushed.map((p) => (
              <li key={p.reference}>
                {i18n.rich(text.pushed, { reference: <Mono>{p.reference}</Mono> })}
                {p.digest ? (
                  <>
                    {" "}
                    <Mono className="text-muted-foreground">{p.digest}</Mono>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  }
  if (done.status === "cancelled") {
    return (
      <div role="status" className="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground" data-testid="stream-result">
        <CircleSlashIcon className="size-4" />
        {what === "build" ? text.buildCancelled : text.pushCancelled}
      </div>
    )
  }
  return (
    <div role="alert" className="grid gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid="stream-result">
      <p className="flex items-center gap-2 font-medium text-destructive">
        <CircleAlertIcon className="size-4" />
        {what === "build" ? text.buildFailed : text.pushFailed}
      </p>
      <p className="break-words whitespace-pre-wrap">{done.error}</p>
      {done.hint === "registries" ? (
        <p>
          <Link href="/registries" className="font-medium underline underline-offset-4">
            {text.openRegistries}
          </Link>
        </p>
      ) : null}
    </div>
  )
}

export function RunningNote({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <LoaderIcon className="size-4 animate-spin" />
      {text}
    </p>
  )
}
