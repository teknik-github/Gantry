"use client"

import { useActionState } from "react"

import { setupAdmin } from "@/app/(auth)/actions"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/lib/i18n/client"
import type { ActionState } from "@/lib/validation"

export function SetupForm({ token }: { token?: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(setupAdmin, {})
  const errs = state.fieldErrors ?? {}
  const i18n = useI18n()
  const { t } = i18n

  return (
    <form action={action} className="flex flex-col gap-6">
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">{t.auth.setup.title}</h1>
          <p className="text-sm text-balance text-muted-foreground">
            {t.auth.setup.description}
          </p>
        </div>
        <Field data-invalid={errs.token ? true : undefined}>
          <FieldLabel htmlFor="token">{t.auth.setup.token}</FieldLabel>
          <Input
            id="token"
            name="token"
            autoComplete="off"
            spellCheck={false}
            defaultValue={state.values?.token ?? token}
            required
            aria-invalid={errs.token ? true : undefined}
            className="bg-background font-mono"
          />
          {errs.token ? (
            <FieldError>{errs.token[0]}</FieldError>
          ) : (
            <FieldDescription>
              {i18n.rich(t.auth.setup.tokenHelp, {
                logs: <code>docker logs gantry</code>,
                file: <code>DATA_DIR/setup-token</code>,
              })}
            </FieldDescription>
          )}
        </Field>
        {(
          [
            ["username", t.common.fields.username, "text", "username"],
            ["password", t.common.fields.password, "password", "new-password"],
            ["confirm", t.auth.setup.confirm, "password", "new-password"],
          ] as const
        ).map(([name, label, type, autoComplete]) => (
          <Field key={name} data-invalid={errs[name] ? true : undefined}>
            <FieldLabel htmlFor={name}>{label}</FieldLabel>
            <Input
              id={name}
              name={name}
              type={type}
              autoComplete={autoComplete}
              defaultValue={name === "username" ? state.values?.username : undefined}
              required
              aria-invalid={errs[name] ? true : undefined}
              className="bg-background"
            />
            {errs[name] ? <FieldError>{errs[name]![0]}</FieldError> : null}
          </Field>
        ))}
        <Field>
          {state.error && !state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}
          <Button type="submit" disabled={pending}>
            {pending ? t.auth.setup.creating : t.auth.setup.submit}
          </Button>
          <FieldDescription className="text-center">
            {t.auth.setup.passwordHint}
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  )
}
