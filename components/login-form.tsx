"use client"

import { useActionState } from "react"

import { cn } from "@/lib/utils"
import { login } from "@/app/(auth)/actions"
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

export function LoginForm({
  next,
  className,
  ...props
}: React.ComponentProps<"form"> & { next?: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(login, {})

  return (
    <form action={action} className={cn("flex flex-col gap-6", className)} {...props}>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Login to Gantry</h1>
          <p className="text-sm text-balance text-muted-foreground">
            Enter your username and password to continue
          </p>
        </div>
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <Field>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            placeholder="admin"
            defaultValue={state.values?.username}
            required
            autoFocus
            className="bg-background"
          />
        </Field>
        <Field data-invalid={state.error ? true : undefined}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={state.error ? true : undefined}
            className="bg-background"
          />
          {state.error ? <FieldError>{state.error}</FieldError> : null}
        </Field>
        <Field>
          <Button type="submit" disabled={pending}>
            {pending ? "Signing in…" : "Login"}
          </Button>
          <FieldDescription className="text-center">
            Forgot your password? Ask a Gantry administrator to reset it.
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  )
}
