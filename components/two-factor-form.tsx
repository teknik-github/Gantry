"use client"

import * as React from "react"
import { useActionState } from "react"

import { cancelTwoFactor, verifyLoginCode } from "@/app/(auth)/actions"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { ActionState } from "@/lib/validation"

/** Second login step: a code from the authenticator app or a recovery code. */
export function TwoFactorForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(verifyLoginCode, {})
  const id = React.useId()
  const error = state.fieldErrors?.code?.[0] ?? state.error

  return (
    <div className="flex flex-col gap-6">
      <form action={action}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="text-2xl font-bold">Two-factor authentication</h1>
            <p className="text-sm text-balance text-muted-foreground">
              Enter the 6-digit code from your authenticator app
            </p>
          </div>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={`${id}-code`}>Code</FieldLabel>
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
            <FieldDescription>Lost your device? Enter one of your recovery codes instead.</FieldDescription>
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <Field>
            <Button type="submit" disabled={pending}>
              {pending ? "Verifying…" : "Verify"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
      <form action={cancelTwoFactor} className="text-center">
        <Button type="submit" variant="link" size="sm" className="text-muted-foreground">
          Use another account
        </Button>
      </form>
    </div>
  )
}
