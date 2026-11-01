"use client"

import * as React from "react"
import { useActionState } from "react"

import { cancelTwoFactor, verifyLoginCode } from "@/app/(auth)/actions"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/lib/i18n/client"
import type { ActionState } from "@/lib/validation"

/** Second login step: a code from the authenticator app or a recovery code. */
export function TwoFactorForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(verifyLoginCode, {})
  const id = React.useId()
  const { t } = useI18n()
  const error = state.fieldErrors?.code?.[0] ?? state.error

  return (
    <div className="flex flex-col gap-6">
      <form action={action}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="text-2xl font-bold">{t.auth.twoFactor.title}</h1>
            <p className="text-sm text-balance text-muted-foreground">
              {t.auth.twoFactor.description}
            </p>
          </div>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={`${id}-code`}>{t.auth.twoFactor.code}</FieldLabel>
            <Input
              id={`${id}-code`}
              name="code"
              autoComplete="one-time-code"
              inputMode="text"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={32}
              required
              autoFocus
              aria-invalid={error ? true : undefined}
              className="bg-background font-mono tracking-widest"
            />
            <FieldDescription>{t.auth.twoFactor.lostDevice}</FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <Field>
            <Button type="submit" disabled={pending}>
              {pending ? t.auth.twoFactor.verifying : t.auth.twoFactor.verify}
            </Button>
          </Field>
        </FieldGroup>
      </form>
      <form action={cancelTwoFactor} className="text-center">
        <Button type="submit" variant="link" size="sm" className="text-muted-foreground">
          {t.auth.twoFactor.anotherAccount}
        </Button>
      </form>
    </div>
  )
}
