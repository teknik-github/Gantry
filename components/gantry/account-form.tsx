"use client"

import { useActionState, useRef } from "react"
import { toast } from "sonner"

import { changePassword } from "@/app/(app)/account/actions"
import { submitKeepingValues } from "@/components/gantry/use-action"
import { Button } from "@/components/ui/button"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { ActionState } from "@/lib/validation"

export function ChangePasswordForm() {
  const formRef = useRef<HTMLFormElement>(null)
  const [state, action, pending] = useActionState(async (prev: ActionState, fd: FormData) => {
    const res = await changePassword(prev, fd)
    if (res.ok) {
      toast.success(res.message ?? "Password changed")
      formRef.current?.reset()
    }
    return res
  }, {})
  const errs = state.fieldErrors ?? {}

  return (
    <form method="post" ref={formRef} onSubmit={submitKeepingValues(action)} className="max-w-sm">
      <FieldGroup>
        {(
          [
            ["current", "Current password", "current-password"],
            ["password", "New password", "new-password"],
            ["confirm", "Confirm new password", "new-password"],
          ] as const
        ).map(([name, label, autoComplete]) => (
          <Field key={name} data-invalid={errs[name] ? true : undefined}>
            <FieldLabel htmlFor={name}>{label}</FieldLabel>
            <Input id={name} name={name} type="password" autoComplete={autoComplete} required />
            <FieldError>{errs[name]?.[0]}</FieldError>
          </Field>
        ))}
        {state.error && !state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}
        <Field orientation="horizontal">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Change password"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
