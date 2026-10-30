"use client"

import * as React from "react"
import { useActionState } from "react"
import { toast } from "sonner"
import { CopyIcon, KeyRoundIcon, LinkIcon, PlusIcon, ShieldCheckIcon, ShieldOffIcon, Trash2Icon } from "lucide-react"

import {
  confirmTwoFactor,
  createToken,
  disableTwoFactorAction,
  linkSso,
  regenerateRecoveryCodesAction,
  revokeToken,
  startTwoFactor,
  type EnrolmentState,
  type RecoveryCodesState,
  type TokenState,
} from "@/app/(app)/account/actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { Mono } from "@/components/gantry/ui"
import { submitKeepingValues, useRunAction } from "@/components/gantry/use-action"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { ActionState } from "@/lib/validation"

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error("Copy failed; select the text instead")
  }
}

/** Shown once: the recovery codes after enabling 2FA or regenerating them. */
function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Store these somewhere safe. Each one signs you in once if you lose your authenticator. They won&apos;t be shown
        again.
      </p>
      <ol className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-3 font-mono text-sm" data-testid="recovery-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => copy(codes.join("\n"), "Recovery codes")}>
        <CopyIcon data-icon="inline-start" />
        Copy codes
      </Button>
    </div>
  )
}

function PasswordField({ id, error }: { id: string; error?: string }) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={`${id}-password`}>Current password</FieldLabel>
      <Input id={`${id}-password`} name="password" type="password" autoComplete="current-password" required autoFocus />
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  )
}

function CodeField({ id, error, description }: { id: string; error?: string; description?: string }) {
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={`${id}-code`}>Authentication code</FieldLabel>
      <Input
        id={`${id}-code`}
        name="code"
        autoComplete="one-time-code"
        spellCheck={false}
        maxLength={32}
        required
        className="font-mono tracking-widest"
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  )
}

// ----------------------------------------------------------------- 2FA card

type Step = "closed" | "password" | "scan" | "codes"

/**
 * Two-factor authentication: enrol (password → QR code → verify a code →
 * recovery codes), regenerate recovery codes, or turn it off (password +
 * code). The dialogs live at card level so a refresh after enabling doesn't
 * unmount the recovery codes before they were saved.
 */
export function TwoFactorCard({ enabled, recoveryCodesLeft }: { enabled: boolean; recoveryCodesLeft: number }) {
  const id = React.useId()
  const [step, setStep] = React.useState<Step>("closed")
  const [enrolment, setEnrolment] = React.useState<EnrolmentState>({})
  const [codes, setCodes] = React.useState<string[] | null>(null)
  const [manage, setManage] = React.useState<"off" | "regenerate" | null>(null)

  const [startState, start, starting] = useActionState(async (prev: EnrolmentState, fd: FormData) => {
    const res = await startTwoFactor(prev, fd)
    if (res.ok) {
      setEnrolment(res)
      setStep("scan")
    }
    return res
  }, {})
  const [confirmState, confirm, confirming] = useActionState(async (prev: RecoveryCodesState, fd: FormData) => {
    const res = await confirmTwoFactor(prev, fd)
    if (res.ok && res.recoveryCodes) {
      // Forget the secret on the client as soon as it is no longer needed.
      setEnrolment({})
      setCodes(res.recoveryCodes)
      setStep("codes")
      toast.success(res.message ?? "Two-factor authentication is on")
    }
    return res
  }, {})

  const close = () => {
    setStep("closed")
    setEnrolment({})
    setCodes(null)
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {enabled ? (
          <>
            <Badge variant="outline" className="gap-1 text-emerald-700 dark:text-emerald-400" data-testid="2fa-status">
              <ShieldCheckIcon />
              On
            </Badge>
            <span className="text-sm text-muted-foreground">{recoveryCodesLeft} recovery code(s) left</span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setManage("regenerate")}>
                New recovery codes
              </Button>
              <Button size="sm" variant="outline" onClick={() => setManage("off")}>
                <ShieldOffIcon data-icon="inline-start" />
                Turn off
              </Button>
            </div>
          </>
        ) : (
          <>
            <Badge variant="outline" className="text-muted-foreground" data-testid="2fa-status">
              Off
            </Badge>
            <Button size="sm" className="ml-auto" onClick={() => setStep("password")}>
              <ShieldCheckIcon data-icon="inline-start" />
              Set up two-factor
            </Button>
          </>
        )}
      </div>

      <Dialog open={step !== "closed"} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{step === "codes" ? "Save your recovery codes" : "Set up two-factor authentication"}</DialogTitle>
            <DialogDescription>
              {step === "password"
                ? "Confirm your password to start."
                : step === "scan"
                  ? "Scan the QR code with an authenticator app (or enter the key), then type the 6-digit code it shows."
                  : "Two-factor authentication is on."}
            </DialogDescription>
          </DialogHeader>
          {step === "password" ? (
            <form action={start} className="flex flex-col gap-5">
              <PasswordField id={`${id}-start`} error={startState.fieldErrors?.password?.[0] ?? (startState.ok ? undefined : startState.error)} />
              <DialogFooter>
                <Button type="submit" disabled={starting}>
                  {starting ? "Checking…" : "Continue"}
                </Button>
              </DialogFooter>
            </form>
          ) : step === "scan" && enrolment.secret ? (
            <form action={confirm} className="flex flex-col gap-5">
              {enrolment.qrSvg ? (
                // Rendered on the server from the otpauth:// URI; a data URI keeps the markup inert.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`data:image/svg+xml;utf8,${encodeURIComponent(enrolment.qrSvg)}`}
                  alt="QR code for your authenticator app"
                  className="mx-auto size-48 rounded-md bg-white p-1"
                />
              ) : null}
              <div className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Key (if you can&apos;t scan)</span>
                <div className="flex items-center gap-2">
                  <Mono className="break-all" data-testid="totp-secret">
                    {enrolment.secret}
                  </Mono>
                  <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Copy key" onClick={() => copy(enrolment.secret!, "Key")}>
                    <CopyIcon />
                  </Button>
                </div>
                <a href={enrolment.uri} className="w-fit text-xs underline underline-offset-4">
                  Open in authenticator app
                </a>
              </div>
              <CodeField id={`${id}-confirm`} error={confirmState.fieldErrors?.code?.[0]} />
              <DialogFooter>
                <Button type="submit" disabled={confirming}>
                  {confirming ? "Verifying…" : "Turn on"}
                </Button>
              </DialogFooter>
            </form>
          ) : step === "codes" && codes ? (
            <>
              <RecoveryCodes codes={codes} />
              <DialogFooter>
                <Button type="button" onClick={close}>
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <ManageTwoFactorDialog mode={manage} onClose={() => setManage(null)} />
    </div>
  )
}

function ManageTwoFactorDialog({ mode, onClose }: { mode: "off" | "regenerate" | null; onClose: () => void }) {
  const id = React.useId()
  const [codes, setCodes] = React.useState<string[] | null>(null)
  const [state, action, pending] = useActionState(async (prev: RecoveryCodesState, fd: FormData) => {
    const res: RecoveryCodesState =
      mode === "off" ? await disableTwoFactorAction(prev, fd) : await regenerateRecoveryCodesAction(prev, fd)
    if (res.ok) {
      toast.success(res.message ?? "Done")
      if (res.recoveryCodes) setCodes(res.recoveryCodes)
      else onClose()
    }
    return res
  }, {})

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(o) => {
        if (!o) {
          setCodes(null)
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "off" ? "Turn off two-factor authentication" : "New recovery codes"}</DialogTitle>
          <DialogDescription>
            {mode === "off"
              ? "Your password alone will sign you in again. Other sessions are signed out."
              : "The current recovery codes stop working."}
          </DialogDescription>
        </DialogHeader>
        {codes ? (
          <>
            <RecoveryCodes codes={codes} />
            <DialogFooter>
              <Button
                type="button"
                onClick={() => {
                  setCodes(null)
                  onClose()
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form action={action} className="flex flex-col gap-5" key={mode ?? "closed"}>
            <PasswordField id={`${id}-pw`} />
            <CodeField id={`${id}-code`} description="From your authenticator app, or a recovery code." />
            {state.error ? <FieldError>{state.error}</FieldError> : null}
            <DialogFooter>
              <Button type="submit" variant={mode === "off" ? "destructive" : "default"} disabled={pending}>
                {pending ? "Working…" : mode === "off" ? "Turn off" : "Create new codes"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- API tokens

export type TokenRow = {
  id: number
  name: string
  prefix: string
  createdLabel: string
  expiresLabel: string
  lastUsedLabel: string
  expired: boolean
}

/** Personal API tokens: list, create (shown once), revoke. */
export function ApiTokensCard({ tokens }: { tokens: TokenRow[] }) {
  const id = React.useId()
  const [open, setOpen] = React.useState(false)
  const [formKey, setFormKey] = React.useState(0)
  const [created, setCreated] = React.useState<string | null>(null)
  const [state, action, pending] = useActionState(async (prev: TokenState, fd: FormData) => {
    const res = await createToken(prev, fd)
    if (res.ok && res.token) setCreated(res.token)
    return res
  }, {})
  const errs = state.fieldErrors ?? {}

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={() => {
            setCreated(null)
            setFormKey((k) => k + 1)
            setOpen(true)
          }}
        >
          <PlusIcon data-icon="inline-start" />
          New token
        </Button>
      </div>
      {tokens.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell>
                  <Mono className="text-muted-foreground">{t.prefix}…</Mono>
                </TableCell>
                <TableCell className="text-muted-foreground">{t.createdLabel}</TableCell>
                <TableCell className={t.expired ? "text-destructive" : "text-muted-foreground"}>{t.expiresLabel}</TableCell>
                <TableCell className="text-muted-foreground">{t.lastUsedLabel}</TableCell>
                <TableCell className="text-right">
                  <ConfirmAction
                    title={`Revoke token ${t.name}?`}
                    description="Scripts using it get 401 Unauthorized from now on."
                    confirmLabel="Revoke"
                    onConfirm={() => revokeToken(t.id)}
                  >
                    <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Revoke ${t.name}`}>
                      <Trash2Icon />
                    </Button>
                  </ConfirmAction>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">No tokens yet.</p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{created ? "Copy your token" : "New API token"}</DialogTitle>
            <DialogDescription>
              {created
                ? "This is the only time it is shown. It acts with your permissions on the /api endpoints."
                : "For scripts: send it as Authorization: Bearer <token> to /api/* endpoints. It has your permissions."}
            </DialogDescription>
          </DialogHeader>
          {created ? (
            <>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3">
                <Mono className="break-all" data-testid="new-token">
                  {created}
                </Mono>
                <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Copy token" onClick={() => copy(created, "Token")}>
                  <CopyIcon />
                </Button>
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  onClick={() => {
                    setCreated(null)
                    setOpen(false)
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            // Radix Select inside: submit without React's form reset.
            <form key={formKey} method="post" onSubmit={submitKeepingValues(action)} className="flex flex-col gap-5">
              <FieldGroup>
                <Field data-invalid={errs.name ? true : undefined}>
                  <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                  <Input id={`${id}-name`} name="name" placeholder="backup script" maxLength={64} required autoFocus />
                  <FieldError>{errs.name?.[0]}</FieldError>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-expires`}>Expires</FieldLabel>
                  <Select name="expires" defaultValue="90">
                    <SelectTrigger id={`${id}-expires`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="30">In 30 days</SelectItem>
                      <SelectItem value="90">In 90 days</SelectItem>
                      <SelectItem value="365">In a year</SelectItem>
                      <SelectItem value="never">Never</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>
              {state.error && !state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}
              <DialogFooter>
                <Button type="submit" disabled={pending}>
                  <KeyRoundIcon data-icon="inline-start" />
                  {pending ? "Creating…" : "Create token"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// --------------------------------------------------------------- SSO link

export function LinkSsoButton() {
  const [pending, run] = useRunAction()
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => linkSso() as Promise<ActionState>)}>
      <LinkIcon data-icon="inline-start" />
      Link SSO account
    </Button>
  )
}
