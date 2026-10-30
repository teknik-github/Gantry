"use client"

import "@xterm/xterm/css/xterm.css"

import * as React from "react"
import { useRouter } from "next/navigation"
import type { FitAddon } from "@xterm/addon-fit"
import type { Terminal } from "@xterm/xterm"
import { PlugIcon, PlugZapIcon, TerminalSquareIcon } from "lucide-react"

import { startExecSession, type ExecShell } from "@/app/(app)/containers/actions"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

type Status = "idle" | "connecting" | "connected" | "exited" | "error"

const STATUS: Record<Status, { label: string; dot: string }> = {
  idle: { label: "Not connected", dot: "bg-muted-foreground" },
  connecting: { label: "Connecting…", dot: "bg-amber-500" },
  connected: { label: "Connected", dot: "bg-emerald-500" },
  exited: { label: "Exited", dot: "bg-muted-foreground" },
  error: { label: "Error", dot: "bg-red-500" },
}

const THEME = {
  background: "#0a0a0a",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  selectionBackground: "#404040",
  black: "#171717",
  brightBlack: "#525252",
}

type OpenConsole = (opts: {
  shell: ExecShell
  user: string
  cols: number
  rows: number
}) => Promise<{ sid: string; error?: never } | { sid?: never; error: string }>

/**
 * Interactive shell in a running container. Output streams from
 * GET /api/exec/:sid, keystrokes and resizes go out as POSTs. Pass
 * `containerId` for a Docker container, or `open` for another runtime
 * (Kubernetes pods), with `controls` for its own choices (the container).
 */
export function ExecConsole({
  containerId,
  open,
  running,
  description = "Interactive shell inside the container (docker exec)",
  allowUser = true,
  controls,
}: {
  containerId?: string
  open?: OpenConsole
  running: boolean
  description?: string
  /** Docker can run the shell as another user; Kubernetes exec can't. */
  allowUser?: boolean
  controls?: React.ReactNode
}) {
  const router = useRouter()
  const environmentId = useEnvironmentId()
  const hostRef = React.useRef<HTMLDivElement>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  const sidRef = React.useRef<string | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)
  const pendingInput = React.useRef("")
  const sending = React.useRef(false)

  const [status, setStatus] = React.useState<Status>("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [shell, setShell] = React.useState<ExecShell>("auto")
  const [user, setUser] = React.useState("")
  const [started, setStarted] = React.useState(false)

  const api = React.useCallback((sid: string, init?: RequestInit) => fetch(`/api/exec/${sid}`, init), [])

  // Keystrokes typed while a request is in flight are batched into the next one,
  // and requests are sent one at a time so input stays in order.
  const flushInput = React.useCallback(async () => {
    if (sending.current) return
    sending.current = true
    while (pendingInput.current && sidRef.current) {
      const data = pendingInput.current
      pendingInput.current = ""
      await api(sidRef.current, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      }).catch(() => {})
    }
    sending.current = false
  }, [api])

  const ensureTerminal = React.useCallback(async () => {
    if (termRef.current) return termRef.current
    const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")])
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono").trim()
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: `${mono ? `${mono}, ` : ""}ui-monospace, monospace`,
      theme: THEME,
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    fit.fit()

    term.onData((data) => {
      if (!sidRef.current) return
      pendingInput.current += data
      void flushInput()
    })
    term.onResize(({ cols, rows }) => {
      const sid = sidRef.current
      if (!sid) return
      void api(sid, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {})
    })

    termRef.current = term
    fitRef.current = fit
    return term
  }, [api, flushInput])

  const closeRemote = React.useCallback(
    async (sid: string, keepalive = false) => {
      try {
        const res = await api(sid, { method: "DELETE", keepalive })
        if (res.ok) return ((await res.json()) as { exitCode: number | null }).exitCode
      } catch {}
      return null
    },
    [api]
  )

  async function connect() {
    setError(null)
    setStatus("connecting")
    setStarted(true)
    const term = await ensureTerminal()
    term.reset()
    fitRef.current?.fit()

    const res = open
      ? await open({ shell, user, cols: term.cols, rows: term.rows })
      : await startExecSession({ id: containerId ?? "", shell, user, cols: term.cols, rows: term.rows, environmentId })
    if (res.error !== undefined) {
      setStatus("error")
      setError(res.error)
      return
    }

    const sid = res.sid
    const abort = new AbortController()
    sidRef.current = sid
    abortRef.current = abort

    let response: Response
    try {
      response = await api(sid, { signal: abort.signal, cache: "no-store" })
    } catch {
      setStatus("error")
      setError("Lost connection to the console.")
      return
    }
    if (response.status === 401) return router.replace("/login")
    if (!response.ok || !response.body) {
      setStatus("error")
      setError(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? "Console failed")
      return
    }

    setStatus("connected")
    term.focus()

    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        term.write(value)
      }
    } catch {
      // Aborted by disconnect() or a network error; handled below.
    }

    if (abort.signal.aborted || sidRef.current !== sid) return // disconnected on purpose
    sidRef.current = null
    const exitCode = await closeRemote(sid)
    term.write(`\r\n\x1b[2m[process exited${exitCode === null ? "" : ` with code ${exitCode}`}]\x1b[0m\r\n`)
    setStatus("exited")
  }

  async function disconnect() {
    const sid = sidRef.current
    sidRef.current = null
    abortRef.current?.abort()
    if (sid) await closeRemote(sid)
    termRef.current?.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n")
    setStatus("idle")
  }

  // Keep the terminal sized to its box (also when the tab becomes visible).
  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(() => {
      if (host.offsetParent !== null) fitRef.current?.fit()
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  // Leaving the page closes the console on the server too.
  React.useEffect(() => {
    return () => {
      const sid = sidRef.current
      sidRef.current = null
      abortRef.current?.abort()
      if (sid) void fetch(`/api/exec/${sid}`, { method: "DELETE", keepalive: true }).catch(() => {})
      termRef.current?.dispose()
      termRef.current = null
    }
  }, [])

  const busy = status === "connecting"
  const live = status === "connected"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Console
          <Badge variant="outline" className="gap-1.5 px-1.5 font-normal text-muted-foreground">
            <span className={cn("size-2 rounded-full", STATUS[status].dot)} />
            {STATUS[status].label}
          </Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          {controls}
          <Select value={shell} onValueChange={(v) => setShell(v as ExecShell)} disabled={live || busy}>
            <SelectTrigger size="sm" className="w-32" aria-label="Shell">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto shell</SelectItem>
              <SelectItem value="bash">/bin/bash</SelectItem>
              <SelectItem value="sh">/bin/sh</SelectItem>
            </SelectContent>
          </Select>
          {allowUser ? (
            <Input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="User (default)"
              aria-label="Run as user"
              disabled={live || busy}
              className="h-7 w-36 text-xs"
            />
          ) : null}
          {live ? (
            <Button size="sm" variant="outline" onClick={disconnect}>
              <PlugIcon data-icon="inline-start" />
              Disconnect
            </Button>
          ) : (
            <Button size="sm" onClick={connect} disabled={!running || busy}>
              <PlugZapIcon data-icon="inline-start" />
              {status === "exited" || status === "error" ? "Reconnect" : "Connect"}
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!running ? (
          <p className="text-sm text-muted-foreground">Start the container to open a console.</p>
        ) : null}
        <div className="relative h-[28rem] overflow-hidden rounded-lg border bg-[#0a0a0a] p-2">
          <div ref={hostRef} className="size-full" data-testid="exec-terminal" />
          {!started ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-neutral-400">
              <TerminalSquareIcon className="size-6" />
              Choose a shell and press Connect
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
