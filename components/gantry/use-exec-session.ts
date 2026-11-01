"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import type { FitAddon } from "@xterm/addon-fit"
import type { Terminal } from "@xterm/xterm"

import { startExecSession, type ExecShell } from "@/app/(app)/containers/actions"
import { useEnvironmentId } from "@/components/gantry/environment-scope"
import { useI18n } from "@/lib/i18n/client"

export type ExecStatus = "idle" | "connecting" | "connected" | "exited" | "error"

/** Starts a session for another runtime (Kubernetes pods); resolves to its id. */
export type OpenConsole = (opts: {
  shell: ExecShell
  user: string
  cols: number
  rows: number
}) => Promise<{ sid: string; error?: never } | { sid?: never; error: string }>

const THEME = {
  background: "#0a0a0a",
  foreground: "#e5e5e5",
  cursor: "#e5e5e5",
  selectionBackground: "#404040",
  black: "#171717",
  brightBlack: "#525252",
}

/**
 * An xterm.js terminal (mounted into `hostRef` on the first connect) wired
 * to an exec session: output streams from GET /api/exec/:sid, keystrokes and
 * resizes go out as POSTs, DELETE ends it. Without `open`, connect() starts
 * a shell in the Docker container `containerId`. Unmounting closes the
 * session on the server too.
 */
export function useExecSession({ containerId, open }: { containerId?: string; open?: OpenConsole }) {
  const router = useRouter()
  const i18n = useI18n()
  const text = i18n.t.containers.console
  const environmentId = useEnvironmentId()
  const hostRef = React.useRef<HTMLDivElement>(null)
  const termRef = React.useRef<Terminal | null>(null)
  const fitRef = React.useRef<FitAddon | null>(null)
  const sidRef = React.useRef<string | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)
  const pendingInput = React.useRef("")
  const sending = React.useRef(false)

  const [status, setStatus] = React.useState<ExecStatus>("idle")
  const [error, setError] = React.useState<string | null>(null)
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

  async function connect({ shell, user }: { shell: ExecShell; user: string }) {
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
      setError(text.lostConnection)
      return
    }
    if (response.status === 401) return router.replace("/login")
    if (!response.ok || !response.body) {
      setStatus("error")
      setError(((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? text.failed)
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
    const exited = exitCode === null ? text.processExited : i18n.format(text.processExitedCode, { code: exitCode })
    term.write(`\r\n\x1b[2m${exited}\x1b[0m\r\n`)
    setStatus("exited")
  }

  async function disconnect() {
    const sid = sidRef.current
    sidRef.current = null
    abortRef.current?.abort()
    if (sid) await closeRemote(sid)
    termRef.current?.write(`\r\n\x1b[2m${text.disconnected}\x1b[0m\r\n`)
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

  return { hostRef, status, error, started, connect, disconnect }
}
