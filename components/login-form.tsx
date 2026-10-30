"use client"

import { useActionState } from "react"
import { KeyRoundIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { login } from "@/app/(auth)/actions"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { ActionState } from "@/lib/validation"

export function LoginForm({
  next,
  sso = false,
  ssoMessage,
  passwordForAdminsOnly = false,
  className,
  ...props
}: React.ComponentProps<"form"> & {
  next?: string
  /** Show "Sign in with SSO" (OIDC configured). */
  sso?: boolean
  /** Outcome of a failed single sign-on attempt. */
  ssoMessage?: string
  /** PASSWORD_LOGIN=admins: the password form is the administrators' break-glass access. */
  passwordForAdminsOnly?: boolean
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(login, {})

  return (
    <form action={action} className={cn("flex flex-col gap-6", className)} {...props}>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">Login to Gantry</h1>
          <p className="text-sm text-balance text-muted-foreground">
            {passwordForAdminsOnly
              ? "Sign in with SSO. The password form is for administrators only."
              : "Enter your username and password to continue"}
          </p>
        </div>
        {ssoMessage ? (
          <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
            {ssoMessage}
          </p>
        ) : null}
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
        {sso ? (
          <>
            <FieldSeparator>Or</FieldSeparator>
            <Field>
              {/* A plain link: the route redirects to the identity provider. */}
              <Button variant="outline" asChild>
                <a href={`/auth/oidc/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}>
                  <KeyRoundIcon data-icon="inline-start" />
                  Sign in with SSO
                </a>
              </Button>
            </Field>
          </>
        ) : null}
      </FieldGroup>
    </form>
  )
}
