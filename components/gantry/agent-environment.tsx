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
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
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

async function copy(text: string, what: string, i18n: I18n) {
  const messages = i18n.t.environments.agent
  try {
    await navigator.clipboard.writeText(text)
    toast.success(i18n.format(messages.copied, { what }))
  } catch {
    toast.error(messages.copyFailed)
  }
}

// ------------------------------------------------------------- table cells

export function AgentStatusBadge({ agent, version, error }: { agent: AgentRow; version: string | null; error: string | null }) {
  const { t, format, timeAgo } = useI18n()
  const text = t.environments.agent
  const up = agent.connected && !error
  const label = agent.connected
    ? error
      ? text.connectedUnreachable
      : format(text.connectedVersion, { version: version ?? "Docker" })
    : text.disconnected
  const title = agent.connected
    ? [
        format(text.connectedTitle, { ago: agent.since ? timeAgo(agent.since) : "" }),
        ...(agent.rttMs !== null ? [format(text.roundTrip, { ms: agent.rttMs })] : []),
        ...(error ? [error] : []),
      ].join(" · ")
    : agent.lastSeen
      ? format(text.lastSeenTitle, { ago: timeAgo(agent.lastSeen) })
      : text.neverConnected
  return (
    <Badge variant="outline" className="gap-1.5 px-1.5 text-muted-foreground" title={title}>
      <span className={cn("size-2 rounded-full", up ? "bg-emerald-500" : agent.connected ? "bg-amber-500" : "bg-red-500")} />
      {label}
    </Badge>
  )
}

export function AgentTypeCell({ agent }: { agent: AgentRow }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {t.environments.agent.type}
      {agent.version ? (
        <Badge variant="outline" className="gap-1 px-1.5 text-muted-foreground" title={t.environments.agent.version}>
          <RadioTowerIcon />v{agent.version}
        </Badge>
      ) : null}
    </div>
  )
}

/** Host, remote address and when it was last seen, in place of an address. */
export function AgentAddressCell({ agent }: { agent: AgentRow }) {
  const { t, format, timeAgo } = useI18n()
  const text = t.environments.agent
  return (
    <div className="grid gap-0.5 text-xs" data-testid="agent-address">
      {agent.hostname ? <span className="font-medium">{agent.hostname}</span> : null}
      {agent.remoteAddress ? (
        <Mono className="text-muted-foreground">{format(text.from, { address: agent.remoteAddress })}</Mono>
      ) : null}
      <span className="text-muted-foreground">
        {agent.connected
          ? format(text.connectedAgo, { ago: agent.since ? timeAgo(agent.since) : "" })
          : agent.lastSeen
            ? format(text.lastSeen, { ago: timeAgo(agent.lastSeen) })
            : text.waiting}
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
  const i18n = useI18n()
  const { t, format } = i18n
  const text = t.environments.agent
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="flex items-start gap-2 rounded-lg border border-amber-500/40 p-3 text-xs text-amber-700 dark:text-amber-400">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
        {text.copyNow}
      </p>
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={`${uid}-command`}>{text.command}</FieldLabel>
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => copy(enrollment.command, text.commandWhat, i18n)}>
            <CopyIcon data-icon="inline-start" />
            {t.common.actions.copy}
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
          {i18n.rich(text.commandHelp, { url: <Mono>{enrollment.url}</Mono>, env: <Mono>GANTRY_URL</Mono> })}
        </FieldDescription>
      </Field>
      {enrollment.insecure ? (
        <p className="flex items-start gap-2 rounded-lg border border-red-500/40 p-3 text-xs text-red-700 dark:text-red-400">
          <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" />
          {i18n.rich(text.insecure, { flag: <Mono>-e GANTRY_AGENT_INSECURE=1</Mono> })}
        </p>
      ) : null}
      <Field>
        <div className="flex items-center justify-between gap-2">
          <FieldLabel htmlFor={`${uid}-key`}>{text.key}</FieldLabel>
          <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => copy(enrollment.key, text.keyWhat, i18n)}>
            <CopyIcon data-icon="inline-start" />
            {t.common.actions.copy}
          </Button>
        </div>
        <Input id={`${uid}-key`} readOnly value={enrollment.key} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      </Field>
      <div className="flex items-center gap-2 rounded-lg border p-3 text-sm" role="status" data-testid="agent-enrollment-status">
        {status?.connected ? (
          <>
            <CheckCircle2Icon className="size-4 text-emerald-600" />
            <span>
              {status.hostname
                ? i18n.rich(text.statusConnectedFrom, { host: <span className="font-medium">{status.hostname}</span> })
                : text.statusConnected}
              {status.dockerVersion ? ` ${format(text.statusDocker, { version: status.dockerVersion })}` : ""}
            </span>
          </>
        ) : (
          <>
            <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">{text.statusWaiting}</span>
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
  const { t } = useI18n()
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
          <span className="hidden lg:inline">{t.environments.agent.add}</span>
          <span className="sr-only lg:hidden">{t.environments.agent.add}</span>
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
  const { t, format } = useI18n()
  const text = t.environments.agent
  const [state, action, pending] = useActionState(async (prev: AgentEnrollmentState, fd: FormData) => {
    const res = await createAgentEnvironment(prev, fd)
    if (res.ok) toast.success(res.message ?? text.added)
    return res
  }, {})

  if (state.enrollment) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{format(text.startTitle, { name: state.enrollment.name })}</DialogTitle>
          <DialogDescription>{text.startDescription}</DialogDescription>
        </DialogHeader>
        <AgentEnrollmentPanel enrollment={state.enrollment} />
        <DialogFooter>
          <Button type="button" onClick={onDone}>
            {t.common.status.done}
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{text.add}</DialogTitle>
        <DialogDescription>{text.addDescription}</DialogDescription>
      </DialogHeader>
      <form method="post" onSubmit={submitKeepingValues(action)} className="flex flex-col gap-5">
        <Field data-invalid={state.fieldErrors?.name ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-name`}>{t.common.fields.name}</FieldLabel>
          <Input id={`${uid}-name`} name="name" placeholder={text.namePlaceholder} required autoFocus maxLength={100} />
          <FieldError>{state.fieldErrors?.name?.[0]}</FieldError>
        </Field>
        {state.error && !state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              {t.common.actions.cancel}
            </Button>
          </DialogClose>
          <Button type="submit" disabled={pending}>
            {pending ? t.common.status.working : t.common.actions.create}
          </Button>
        </DialogFooter>
      </form>
    </>
  )
}

const EnrollmentContext = React.createContext<(enrollment: AgentEnrollment) => void>(() => {})

/**
 * Shows the key after a rotation. Lives above the table: the action's
 * refresh re-renders the rows (and may remount their buttons), which must
 * not drop a key that is only shown once.
 */
export function AgentEnrollmentProvider({ children }: { children: React.ReactNode }) {
  const [enrollment, setEnrollment] = React.useState<AgentEnrollment | null>(null)
  const i18n = useI18n()
  const { t, format } = i18n
  return (
    <EnrollmentContext.Provider value={setEnrollment}>
      {children}
      <Dialog open={enrollment !== null} onOpenChange={(o) => !o && setEnrollment(null)}>
        <DialogContent className={DIALOG_CLASS}>
          <DialogHeader>
            <DialogTitle>{format(t.environments.agent.newKeyTitle, { name: enrollment?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {i18n.rich(t.environments.agent.newKeyDescription, { command: <Mono>docker rm -f gantry-agent</Mono> })}
            </DialogDescription>
          </DialogHeader>
          {enrollment ? <AgentEnrollmentPanel enrollment={enrollment} /> : null}
          <DialogFooter>
            <Button type="button" onClick={() => setEnrollment(null)}>
              {t.common.status.done}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </EnrollmentContext.Provider>
  )
}

/** Row action: confirm, issue a new key (dropping the connected agent), show it once. */
export function RotateAgentKeyButton({ id, name }: { id: number; name: string }) {
  const [confirming, setConfirming] = React.useState(false)
  const [pending, startTransition] = React.useTransition()
  const showEnrollment = React.useContext(EnrollmentContext)
  const { t, format } = useI18n()
  const text = t.environments.agent

  const rotate = () =>
    startTransition(async () => {
      try {
        const res = await rotateAgentKey(id)
        if (res.error || !res.enrollment) {
          toast.error(res.error ?? text.rotateFailed)
          return
        }
        toast.success(res.message ?? text.rotated)
        setConfirming(false)
        showEnrollment(res.enrollment)
      } catch {
        toast.error(t.common.errors.requestFailed)
      }
    })

  return (
    <AlertDialog open={confirming} onOpenChange={(o) => !pending && setConfirming(o)}>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={text.rotateLabel}>
          <KeyRoundIcon />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{format(text.rotateTitle, { name })}</AlertDialogTitle>
          <AlertDialogDescription>{text.rotateDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t.common.actions.cancel}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(e) => {
              e.preventDefault()
              rotate()
            }}
          >
            {pending ? t.common.status.working : text.rotate}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
