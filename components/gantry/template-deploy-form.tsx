"use client"

import * as React from "react"
import { useActionState } from "react"
import { EyeIcon, EyeOffIcon, RocketIcon, WandSparklesIcon } from "lucide-react"
import { toast } from "sonner"

import { deployTemplate } from "@/app/(app)/templates/actions"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { generatePassword, type TemplateVariable } from "@/lib/templates"
import type { ActionState } from "@/lib/validation"

/**
 * Deploy form for a template: stack name plus one field per variable. Bound
 * with `action=` so it works before hydration; submitted values come back in
 * the state and are used as defaults after React resets the form.
 */
export function TemplateDeployForm({
  templateKey,
  stackName,
  variables,
}: {
  templateKey: string
  stackName: string
  variables: TemplateVariable[]
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(deployTemplate, {})
  React.useEffect(() => {
    if (state.error && !state.fieldErrors) toast.error(state.error)
  }, [state])
  const errs = state.fieldErrors ?? {}
  const values = state.values ?? {}
  // Unique ids: Next keeps recently visited pages (another template's form) hidden in the DOM.
  const nameId = React.useId()

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="template" value={templateKey} />
      <FieldGroup>
        <Field data-invalid={errs.name ? true : undefined} className="max-w-sm">
          <FieldLabel htmlFor={nameId}>Stack name</FieldLabel>
          <Input
            id={nameId}
            name="name"
            defaultValue={values.name ?? stackName}
            autoComplete="off"
            spellCheck={false}
            required
            aria-invalid={errs.name ? true : undefined}
          />
          <FieldDescription>Compose project name. Lowercase letters, digits, - and _.</FieldDescription>
          <FieldError>{errs.name?.[0]}</FieldError>
        </Field>

        {variables.length ? (
          <FieldSet>
            <FieldLegend variant="label">Settings</FieldLegend>
            <FieldDescription>Written to the stack&apos;s .env; you can change them later on the stack page.</FieldDescription>
            <div className="grid gap-4 @3xl/main:grid-cols-2">
              {variables.map((v) => (
                <VariableField
                  key={v.name}
                  variable={v}
                  value={values[`var:${v.name}`]}
                  error={errs[`var:${v.name}`]?.[0]}
                />
              ))}
            </div>
          </FieldSet>
        ) : null}

        {state.error && state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}

        <Field orientation="horizontal">
          <Button type="submit" disabled={pending}>
            <RocketIcon data-icon="inline-start" />
            {pending ? "Deploying…" : "Deploy"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

function VariableField({ variable: v, value, error }: { variable: TemplateVariable; value?: string; error?: string }) {
  const id = `${React.useId()}-${v.name}`
  const ref = React.useRef<HTMLInputElement>(null)
  const [visible, setVisible] = React.useState(false)
  const isPassword = v.type === "password"

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {v.label ?? v.name}
        {v.label ? <code className="text-xs font-normal text-muted-foreground">{v.name}</code> : null}
      </FieldLabel>
      <div className="flex gap-2">
        <Input
          ref={ref}
          id={id}
          name={`var:${v.name}`}
          type={isPassword && !visible ? "password" : v.type === "port" ? "number" : "text"}
          min={v.type === "port" ? 1 : undefined}
          max={v.type === "port" ? 65535 : undefined}
          defaultValue={value ?? (isPassword ? "" : (v.default ?? ""))}
          placeholder={isPassword ? "Generated when empty" : v.default}
          autoComplete={isPassword ? "new-password" : "off"}
          spellCheck={false}
          required={v.required && !isPassword && v.default === undefined}
          aria-invalid={error ? true : undefined}
          className="font-mono text-sm"
        />
        {isPassword ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={visible ? `Hide ${v.name}` : `Show ${v.name}`}
              onClick={() => setVisible((s) => !s)}
            >
              {visible ? <EyeOffIcon /> : <EyeIcon />}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={`Generate ${v.name}`}
              title="Generate a random password"
              onClick={() => {
                if (!ref.current) return
                ref.current.value = generatePassword((b) => crypto.getRandomValues(b))
                setVisible(true)
              }}
            >
              <WandSparklesIcon />
            </Button>
          </>
        ) : null}
      </div>
      {v.description ? <FieldDescription>{v.description}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  )
}
