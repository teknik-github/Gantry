"use client"

import * as React from "react"
import { useActionState } from "react"
import { toast } from "sonner"
import { CheckCircle2Icon, CopyIcon, KeyRoundIcon, Loader2Icon, RadioTowerIcon, ShieldAlertIcon } from "lucide-react"

import {
  agentConnection,
  createAgentEnvironment,
  rotateAgentKey,
  type AgentConnection,
  type AgentEnrollment,
  type AgentEnrollmentState,
} from "@/app/(app)/environments/agent-actions"
import { submitKeepingValues } from "@/components/gantry/use-action"
import { Mono } from "@/components/gantry/ui"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { timeAgo } from "@/lib/format"
import { cn } from "@/lib/utils"

/** What the Environments table shows about an agent environment (never the key). */
export type AgentRow = {
  connected: boolean
  /** Connected since (ISO), when connected. */
  since: string | null
  /** Last time it was connected (ISO). */
  lastSeen: string | null
  version: string | null
  hostname: string | null
  dockerVersion: string | null
  remoteAddress: string | null
  rttMs: number | null
  keyCreatedAt: string | null
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error("Copy failed; select the text instead")
  }
}

// ------------------------------------------------------------- table cells

export function AgentStatusBadge({ agent, version, error }: { agent: AgentRow; version: string | null; error: string | null }) {
  const up = agent.connected && !error
  const label = agent.connected
    ? error
      ? "connected · Docker unreachable"
      : `connected · ${version ?? "Docker"}`
    : "disconnected"
  const title = agent.connected
    ? `Connected ${agent.since ? timeAgo(agent.since) : ""}${agent.rttMs !== null ? ` · ${agent.rttMs} ms round trip` : ""}${error ? ` · ${error}` : ""}`
    : agent.lastSeen
      ? `Last seen ${timeAgo(agent.lastSeen)}`
      : "The agent has never connected"
  return (
    <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground" title={title}>
      <span className={cn("size-2 rounded-full", up ? "bg-emerald-500" : agent.connected ? "bg-amber-500" : "bg-red-500")} />
      {label}
    </Badge>
  )
}

export function AgentTypeCell({ agent }: { agent: AgentRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      Agent
      {agent.version ? (
        <Badge variant="outline" className="gap-1 px-1.5 text-muted-foreground" title="Agent version">
          <RadioTowerIcon />v{agent.version}
        </Badge>
      ) : null}
    </div>
  )
}

/** Host, remote address and when it was last seen, in place of an address. */
export function AgentAddressCell({ agent }: { agent: AgentRow }) {
  return (
    <div className="grid gap-0.5 text-xs" data-testid="agent-address">
      {agent.hostname ? <span className="font-medium">{agent.hostname}</span> : null}
      {agent.remoteAddress ? <Mono className="text-muted-foreground">from {agent.remoteAddress}</Mono> : null}
      <span className="text-muted-foreground">
        {agent.connected
          ? `connected ${agent.since ? timeAgo(agent.since) : ""}`
          : agent.lastSeen
            ? `last seen ${timeAgo(agent.lastSeen)}`
            : "waiting for the agent"}
      </span>
    </div>
  )
}

// ------------------------------------------------------- enrollment panel

/** Polls whether the agent of `id` is connected while `active`. */
function useAgentConnection(id: number, active: boolean) {
  const [state, setState] = React.useState<AgentConnection | null>(null)
  React.useEffect(() => {
    if (!active) return
    let cancelled = false
    const poll = async () => {
      try {
        const s = await agentConnection(id)
        if (!cancelled) setState(s)
      } catch {
        // Try again on the next tick.
      }
    }
    void poll()
    const timer = setInterval(poll, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [id, active])
  return state
}

/**
 * The key and the docker run command, shown once. Waits for the agent to
 * connect so the admin sees it worked.
 */
export function AgentEnrollmentPanel({ enrollment }: { enrollment: AgentEnrollment }) {
  const uid = React.useId()
  const status = useAgentConnection(enrollment.id, true)
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 p-3 text-xs text-amber-700 dark:text-amber-400">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
        Copy the key now: it is stored only as a hash and won&apos;t be shown again. Anyone with it can connect a Docker
        host as this environment.
      </p>
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={`${uid}-command`}>Docker run command</FieldLabel>
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => copy(enrollment.command, "Command")}>
            <CopyIcon data-icon="inline-start" />
            Copy
          </Button>
        </div>
        <Textarea
          id={`${uid}-command`}
          readOnly
          value={enrollment.command}
          spellCheck={false}
          className="h-32 resize-none font-mono text-[11px] leading-tight [field-sizing:fixed]"
          onFocus={(e) => e.currentTarget.select()}
        />
        <FieldDescription>
          Run it on the Docker host. The agent only connects out to <Mono>{enrollment.url}</Mono>; the Docker API is
          not exposed. Set <Mono>GANTRY_URL</Mono> for Gantry if agents should use another address.
        </FieldDescription>
      </Field>
      {enrollment.insecure ? (
        <p className="flex items-start gap-2 rounded-lg border border-red-500/40 p-3 text-xs text-red-700 dark:text-red-400">
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
          Gantry is reached over plain http://, so the key and all Docker traffic would cross the network unencrypted.
          The agent refuses this unless you add <Mono>-e GANTRY_AGENT_INSECURE=1</Mono>. Serve Gantry over HTTPS
          instead.
        </p>
      ) : null}
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={`${uid}-key`}>Enrollment key</FieldLabel>
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => copy(enrollment.key, "Key")}>
            <CopyIcon data-icon="inline-start" />
            Copy
          </Button>
        </div>
        <Input id={`${uid}-key`} readOnly value={enrollment.key} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      </Field>
      <div className="flex items-center gap-2 rounded-lg border p-3 text-sm" role="status" data-testid="agent-enrollment-status">
        {status?.connected ? (
          <>
            <CheckCircle2Icon className="size-4 text-emerald-600" />
            <span>
              Agent connected
              {status.hostname ? (
                <>
                  {" "}
                  from <span className="font-medium">{status.hostname}</span>
                </>
              ) : null}
              {status.dockerVersion ? ` (Docker ${status.dockerVersion})` : ""}
            </span>
          </>
        ) : (
          <>
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">Waiting for the agent to connect…</span>
          </>
        )}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- dialogs

const DIALOG_CLASS = "max-h-[90vh] overflow-y-auto sm:max-w-2xl"

/** "Add agent": a name, then the key and command for the host. */
export function AddAgentDialog() {
  const [open, setOpen] = React.useState(false)
  const [formKey, setFormKey] = React.useState(0)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setFormKey((k) => k + 1)
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <RadioTowerIcon data-icon="inline-start" />
          <span className="hidden lg:inline">Add agent</span>
          <span className="sr-only lg:hidden">Add agent</span>
        </Button>
      </DialogTrigger>
      <DialogContent className={DIALOG_CLASS}>
        <AddAgentForm key={formKey} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function AddAgentForm({ onDone }: { onDone: () => void }) {
  const uid = React.useId()
  const [state, action, pending] = useActionState(async (prev: AgentEnrollmentState, fd: FormData) => {
    const res = await createAgentEnvironment(prev, fd)
    if (res.ok) toast.success(res.message ?? "Agent environment added")
    return res
  }, {})

  if (state.enrollment) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Start the agent on {state.enrollment.name}</DialogTitle>
          <DialogDescription>Run this on the Docker host you want to manage.</DialogDescription>
        </DialogHeader>
        <AgentEnrollmentPanel enrollment={state.enrollment} />
        <DialogFooter>
          <Button type="button" onClick={onDone}>
            Done
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add agent</DialogTitle>
        <DialogDescription>
          For a Docker host behind NAT or a firewall: a small agent container on it connects out to Gantry, and Gantry
          manages the host through that connection. No Docker API port or TLS setup on the host. Only administrators
          can use it until you grant access.
        </DialogDescription>
      </DialogHeader>
      <form method="post" onSubmit={submitKeepingValues(action)} className="flex flex-col gap-5">
        <Field data-invalid={state.fieldErrors?.name ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-name`}>Name</FieldLabel>
          <Input id={`${uid}-name`} name="name" placeholder="edge-host" required autoFocus maxLength={100} />
          <FieldError>{state.fieldErrors?.name?.[0]}</FieldError>
        </Field>
        {state.error && !state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" disabled={pending}>
            {pending ? "Working…" : "Create"}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

/** Row action: confirm, issue a new key (dropping the connected agent), show it once. */
export function RotateAgentKeyButton({ id, name }: { id: number; name: string }) {
  const [confirming, setConfirming] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const [enrollment, setEnrollment] = React.useState<AgentEnrollment | null>(null)

  const rotate = () =>
    startTransition(async () => {
      try {
        const res = await rotateAgentKey(id)
        if (res.error || !res.enrollment) {
          toast.error(res.error ?? "Could not rotate the key")
          return
        }
        toast.success(res.message ?? "Key rotated")
        setConfirming(false)
        setEnrollment(res.enrollment)
      } catch {
        toast.error("Request failed. Check your connection.")
      }
    })

  return (
    <>
      <AlertDialog open={confirming} onOpenChange={(o) => !pending && setConfirming(o)}>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label="Rotate agent key">
            <KeyRoundIcon />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate the agent key of {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              A new key is issued and the current one stops working at once: the connected agent is disconnected
              until you run it again with the new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(e) => {
                e.preventDefault()
                rotate()
              }}
            >
              {pending ? "Working…" : "Rotate key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={enrollment !== null} onOpenChange={(o) => !o && setEnrollment(null)}>
        <DialogContent className={DIALOG_CLASS}>
          <DialogHeader>
            <DialogTitle>New key for {name}</DialogTitle>
            <DialogDescription>
              Replace the agent on the host: <Mono>docker rm -f gantry-agent</Mono>, then run the command below.
            </DialogDescription>
          </DialogHeader>
          {enrollment ? <AgentEnrollmentPanel enrollment={enrollment} /> : null}
          <DialogFooter>
            <Button type="button" onClick={() => setEnrollment(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
