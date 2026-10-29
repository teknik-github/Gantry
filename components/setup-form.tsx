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
import type { ActionState } from "@/lib/validation"

export function SetupForm({ token }: { token?: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(setupAdmin, {})
  const errs = state.fieldErrors ?? {}

  return (
    <form action={action} className="flex flex-col gap-6">
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Welcome to Gantry</h1>
          <p className="text-sm text-balance text-muted-foreground">
            Create the administrator account to finish setting up
          </p>
        </div>
        <Field data-invalid={errs.token ? true : undefined}>
          <FieldLabel htmlFor="token">Setup token</FieldLabel>
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
              Printed in the server log (<code>docker logs gantry</code>) and stored in{" "}
              <code>DATA_DIR/setup-token</code>.
            </FieldDescription>
          )}
        </Field>
        {(
          [
            ["username", "Username", "text", "username"],
            ["password", "Password", "password", "new-password"],
            ["confirm", "Confirm password", "password", "new-password"],
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
            {pending ? "Creating…" : "Create administrator"}
          </Button>
          <FieldDescription className="text-center">
            Use at least 8 characters for the password.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  )
}
