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
import { useI18n } from "@/lib/i18n/client"
import type { I18n } from "@/lib/i18n"
import type { ActionState } from "@/lib/validation"

async function copy(i18n: I18n, text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(i18n.format(i18n.t.account.twoFactor.copied, { what }))
  } catch {
    toast.error(i18n.t.account.twoFactor.copyFailed)
  }
}

/** Shown once: the recovery codes after enabling 2FA or regenerating them. */
function RecoveryCodes({ codes }: { codes: string[] }) {
  const i18n = useI18n()
  const { t } = i18n
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t.account.twoFactor.codesHelp}</p>
      <ol className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-3 font-mono text-sm" data-testid="recovery-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => copy(i18n, codes.join("\n"), t.account.twoFactor.recoveryCodes)}>
        <CopyIcon data-icon="inline-start" />
        {t.account.twoFactor.copyCodes}
      </Button>
    </div>
  )
}

function PasswordField({ id, error }: { id: string; error?: string }) {
  const { t } = useI18n()
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={`${id}-password`}>{t.account.password.current}</FieldLabel>
      <Input id={`${id}-password`} name="password" type="password" autoComplete="current-password" required autoFocus />
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  )
}

function CodeField({ id, error, description }: { id: string; error?: string; description?: string }) {
  const { t } = useI18n()
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={`${id}-code`}>{t.account.twoFactor.codeLabel}</FieldLabel>
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
  const i18n = useI18n()
  const { t } = i18n
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
      toast.success(res.message ?? t.account.twoFactor.enabled)
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
              {t.account.twoFactor.on}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {i18n.format(t.account.twoFactor.codesLeft, { count: recoveryCodesLeft })}
            </span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setManage("regenerate")}>
                {t.account.twoFactor.newCodes}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setManage("off")}>
                <ShieldOffIcon data-icon="inline-start" />
                {t.account.twoFactor.turnOff}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Badge variant="outline" className="text-muted-foreground" data-testid="2fa-status">
              {t.account.twoFactor.off}
            </Badge>
            <Button size="sm" className="ml-auto" onClick={() => setStep("password")}>
              <ShieldCheckIcon data-icon="inline-start" />
              {t.account.twoFactor.setUp}
            </Button>
          </>
        )}
      </div>

      <Dialog open={step !== "closed"} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{step === "codes" ? t.account.twoFactor.saveCodesTitle : t.account.twoFactor.setUpTitle}</DialogTitle>
            <DialogDescription>
              {step === "password"
                ? t.account.twoFactor.confirmPassword
                : step === "scan"
                  ? t.account.twoFactor.scan
                  : t.account.twoFactor.isOn}
            </DialogDescription>
          </DialogHeader>
          {step === "password" ? (
            <form action={start} className="flex flex-col gap-5">
              <PasswordField id={`${id}-start`} error={startState.fieldErrors?.password?.[0] ?? (startState.ok ? undefined : startState.error)} />
              <DialogFooter>
                <Button type="submit" disabled={starting}>
                  {starting ? t.account.twoFactor.checking : t.common.actions.continue}
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
                  alt={t.account.twoFactor.qrAlt}
                  className="mx-auto size-48 rounded-md bg-white p-1"
                />
              ) : null}
              <div className="grid gap-1 text-sm">
                <span className="text-muted-foreground">{t.account.twoFactor.keyLabel}</span>
                <div className="flex items-center gap-2">
                  <Mono className="break-all" data-testid="totp-secret">
                    {enrolment.secret}
                  </Mono>
                  <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={t.account.twoFactor.copyKey} onClick={() => copy(i18n, enrolment.secret!, t.account.twoFactor.key)}>
                    <CopyIcon />
                  </Button>
                </div>
                <a href={enrolment.uri} className="w-fit text-xs underline underline-offset-4">
                  {t.account.twoFactor.openInApp}
                </a>
              </div>
              <CodeField id={`${id}-confirm`} error={confirmState.fieldErrors?.code?.[0]} />
              <DialogFooter>
                <Button type="submit" disabled={confirming}>
                  {confirming ? t.account.twoFactor.verifying : t.account.twoFactor.turnOn}
                </Button>
              </DialogFooter>
            </form>
          ) : step === "codes" && codes ? (
            <>
              <RecoveryCodes codes={codes} />
              <DialogFooter>
                <Button type="button" onClick={close}>
                  {t.common.status.done}
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
  const { t } = useI18n()
  const [codes, setCodes] = React.useState<string[] | null>(null)
  const [state, action, pending] = useActionState(async (prev: RecoveryCodesState, fd: FormData) => {
    const res: RecoveryCodesState =
      mode === "off" ? await disableTwoFactorAction(prev, fd) : await regenerateRecoveryCodesAction(prev, fd)
    if (res.ok) {
      toast.success(res.message ?? t.common.status.done)
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
          <DialogTitle>{mode === "off" ? t.account.twoFactor.turnOffTitle : t.account.twoFactor.newCodes}</DialogTitle>
          <DialogDescription>
            {mode === "off" ? t.account.twoFactor.turnOffDescription : t.account.twoFactor.newCodesDescription}
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
                {t.common.status.done}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form action={action} className="flex flex-col gap-5" key={mode ?? "closed"}>
            <PasswordField id={`${id}-pw`} />
            <CodeField id={`${id}-code`} description={t.account.twoFactor.codeDescription} />
            {state.error ? <FieldError>{state.error}</FieldError> : null}
            <DialogFooter>
              <Button type="submit" variant={mode === "off" ? "destructive" : "default"} disabled={pending}>
                {pending ? t.common.status.working : mode === "off" ? t.account.twoFactor.turnOff : t.account.twoFactor.createCodes}
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
  const i18n = useI18n()
  const { t } = i18n
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
          {t.account.tokens.new}
        </Button>
      </div>
      {tokens.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.common.fields.name}</TableHead>
              <TableHead>{t.account.tokens.token}</TableHead>
              <TableHead>{t.common.fields.created}</TableHead>
              <TableHead>{t.account.tokens.expires}</TableHead>
              <TableHead>{t.account.tokens.lastUsed}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((token) => (
              <TableRow key={token.id}>
                <TableCell className="font-medium">{token.name}</TableCell>
                <TableCell>
                  <Mono className="text-muted-foreground">{token.prefix}…</Mono>
                </TableCell>
                <TableCell className="text-muted-foreground">{token.createdLabel}</TableCell>
                <TableCell className={token.expired ? "text-destructive" : "text-muted-foreground"}>{token.expiresLabel}</TableCell>
                <TableCell className="text-muted-foreground">{token.lastUsedLabel}</TableCell>
                <TableCell className="text-right">
                  <ConfirmAction
                    title={i18n.format(t.account.tokens.revokeTitle, { name: token.name })}
                    description={t.account.tokens.revokeDescription}
                    confirmLabel={t.account.tokens.revoke}
                    onConfirm={() => revokeToken(token.id)}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-muted-foreground"
                      aria-label={i18n.format(t.account.tokens.revokeLabel, { name: token.name })}
                    >
                      <Trash2Icon />
                    </Button>
                  </ConfirmAction>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">{t.account.tokens.empty}</p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{created ? t.account.tokens.copyTitle : t.account.tokens.newTitle}</DialogTitle>
            <DialogDescription>
              {created ? t.account.tokens.createdDescription : t.account.tokens.newDescription}
            </DialogDescription>
          </DialogHeader>
          {created ? (
            <>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3">
                <Mono className="break-all" data-testid="new-token">
                  {created}
                </Mono>
                <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" aria-label={t.account.tokens.copyToken} onClick={() => copy(i18n, created, t.account.tokens.token)}>
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
                  {t.common.status.done}
                </Button>
              </DialogFooter>
            </>
          ) : (
            // Radix Select inside: submit without React's form reset.
            <form key={formKey} method="post" onSubmit={submitKeepingValues(action)} className="flex flex-col gap-5">
              <FieldGroup>
                <Field data-invalid={errs.name ? true : undefined}>
                  <FieldLabel htmlFor={`${id}-name`}>{t.common.fields.name}</FieldLabel>
                  <Input id={`${id}-name`} name="name" placeholder={t.account.tokens.namePlaceholder} maxLength={64} required autoFocus />
                  <FieldError>{errs.name?.[0]}</FieldError>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-expires`}>{t.account.tokens.expires}</FieldLabel>
                  <Select name="expires" defaultValue="90">
                    <SelectTrigger id={`${id}-expires`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="30">{t.account.tokens.in30Days}</SelectItem>
                      <SelectItem value="90">{t.account.tokens.in90Days}</SelectItem>
                      <SelectItem value="365">{t.account.tokens.inAYear}</SelectItem>
                      <SelectItem value="never">{t.account.tokens.never}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>
              {state.error && !state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}
              <DialogFooter>
                <Button type="submit" disabled={pending}>
                  <KeyRoundIcon data-icon="inline-start" />
                  {pending ? t.account.tokens.creating : t.account.tokens.create}
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
  const { t } = useI18n()
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => linkSso() as Promise<ActionState>)}>
      <LinkIcon data-icon="inline-start" />
      {t.account.sso.link}
    </Button>
  )
}
