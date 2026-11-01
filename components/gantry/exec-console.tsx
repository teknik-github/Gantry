"use client"

import "@xterm/xterm/css/xterm.css"

import * as React from "react"
import { PlugIcon, PlugZapIcon, TerminalSquareIcon } from "lucide-react"

import type { ExecShell } from "@/app/(app)/containers/actions"
import { useExecSession, type ExecStatus, type OpenConsole } from "@/components/gantry/use-exec-session"
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
import { useI18n } from "@/lib/i18n/client"
import { cn } from "@/lib/utils"

// Labels: t.containers.console.status.
const STATUS_DOT: Record<ExecStatus, string> = {
  idle: "bg-muted-foreground",
  connecting: "bg-amber-500",
  connected: "bg-emerald-500",
  exited: "bg-muted-foreground",
  error: "bg-red-500",
}

/**
 * Interactive shell in a running container (the session: useExecSession).
 * Pass `containerId` for a Docker container, or `open` for another runtime
 * (Kubernetes pods), with `controls` for its own choices (the container).
 */
export function ExecConsole({
  containerId,
  open,
  running,
  description,
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
  const i18n = useI18n()
  const text = i18n.t.containers.console
  const { hostRef, status, error, started, connect, disconnect } = useExecSession({ containerId, open })
  const [shell, setShell] = React.useState<ExecShell>("auto")
  const [user, setUser] = React.useState("")

  const busy = status === "connecting"
  const live = status === "connected"

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {text.title}
          <Badge variant="outline" className="gap-1.5 px-1.5 font-normal text-muted-foreground">
            <span className={cn("size-2 rounded-full", STATUS_DOT[status])} />
            {text.status[status]}
          </Badge>
        </CardTitle>
        <CardDescription>{description ?? text.description}</CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          {controls}
          <Select value={shell} onValueChange={(v) => setShell(v as ExecShell)} disabled={live || busy}>
            <SelectTrigger size="sm" className="w-32" aria-label={text.shell}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{text.autoShell}</SelectItem>
              <SelectItem value="bash">/bin/bash</SelectItem>
              <SelectItem value="sh">/bin/sh</SelectItem>
            </SelectContent>
          </Select>
          {allowUser ? (
            <Input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder={text.userPlaceholder}
              aria-label={text.runAsUser}
              disabled={live || busy}
              className="h-7 w-36 text-xs"
            />
          ) : null}
          {live ? (
            <Button size="sm" variant="outline" onClick={disconnect}>
              <PlugIcon data-icon="inline-start" />
              {text.disconnect}
            </Button>
          ) : (
            <Button size="sm" onClick={() => connect({ shell, user })} disabled={!running || busy}>
              <PlugZapIcon data-icon="inline-start" />
              {status === "exited" || status === "error" ? text.reconnect : text.connect}
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {!running ? (
          <p className="text-sm text-muted-foreground">{text.notRunning}</p>
        ) : null}
        <div className="relative h-[28rem] overflow-hidden rounded-lg border bg-[#0a0a0a] p-2 max-sm:h-[60svh]">
          <div ref={hostRef} className="size-full" data-testid="exec-terminal" />
          {!started ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-neutral-400">
              <TerminalSquareIcon className="size-6" />
              {text.hint}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
