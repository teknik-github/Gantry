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
import { useI18n } from "@/lib/i18n/client"
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
  const { t } = useI18n()

  return (
    <form action={action} className={cn("flex flex-col gap-6", className)} {...props}>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">{t.auth.login.title}</h1>
          <p className="text-sm text-balance text-muted-foreground">
            {passwordForAdminsOnly ? t.auth.login.adminsOnly : t.auth.login.description}
          </p>
        </div>
        {ssoMessage ? (
          <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
            {ssoMessage}
          </p>
        ) : null}
        {next ? <input type="hidden" name="next" value={next} /> : null}
        <Field>
          <FieldLabel htmlFor="username">{t.common.fields.username}</FieldLabel>
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
          <FieldLabel htmlFor="password">{t.common.fields.password}</FieldLabel>
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
            {pending ? t.auth.login.signingIn : t.auth.login.submit}
          </Button>
          <FieldDescription className="text-center">
            {t.auth.login.forgot}
          </FieldDescription>
        </Field>
        {sso ? (
          <>
            <FieldSeparator>{t.auth.login.or}</FieldSeparator>
            <Field>
              {/* A plain link: the route redirects to the identity provider. */}
              <Button variant="outline" asChild>
                <a href={`/auth/oidc/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}>
                  <KeyRoundIcon data-icon="inline-start" />
                  {t.auth.login.sso}
                </a>
              </Button>
            </Field>
          </>
        ) : null}
      </FieldGroup>
    </form>
  )
}
