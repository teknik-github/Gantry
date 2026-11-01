"use client"

import * as React from "react"
import { useActionState } from "react"
import { SaveIcon } from "lucide-react"
import { toast } from "sonner"

import { createTemplate, updateTemplate } from "@/app/(app)/templates/actions"
import { EXAMPLE_COMPOSE } from "@/components/gantry/stack-editor"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/lib/i18n/client"
import { mergeVariables } from "@/lib/templates"
import type { ActionState } from "@/lib/validation"

export type TemplateEditorValues = {
  title: string
  description: string
  category: string
  stack_name: string
  compose: string
  env: string
}

/**
 * Create/edit form for a custom template. Bound with `action=` so it works
 * before hydration; submitted values come back in the state.
 */
export function TemplateEditor({ templateKey, initial }: { templateKey?: string; initial?: TemplateEditorValues }) {
  const i18n = useI18n()
  const { t } = i18n
  const text = t.templates.editor
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    templateKey ? updateTemplate : createTemplate,
    {}
  )
  React.useEffect(() => {
    if (state.error && !state.fieldErrors) toast.error(state.error)
  }, [state])
  const errs = state.fieldErrors ?? {}
  const values: Partial<TemplateEditorValues> = { ...initial, ...state.values }

  // Live list of the variables the deploy form will ask for.
  const [compose, setCompose] = React.useState(values.compose ?? EXAMPLE_COMPOSE)
  const [env, setEnv] = React.useState(values.env ?? "")
  const variables = mergeVariables([], compose, env)
  // Unique ids: Next keeps recently visited pages hidden in the DOM.
  const uid = React.useId()

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {templateKey ? <input type="hidden" name="template" value={templateKey} /> : null}
      <FieldGroup>
        <div className="grid gap-4 @3xl/main:grid-cols-2">
          <Field data-invalid={errs.title ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-t-title`}>{text.title}</FieldLabel>
            <Input id={`${uid}-t-title`} name="title" defaultValue={values.title} placeholder={text.titlePlaceholder} required />
            <FieldError>{errs.title?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errs.category ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-t-category`}>{text.category}</FieldLabel>
            <Input id={`${uid}-t-category`} name="category" defaultValue={values.category ?? "Custom"} placeholder="Custom" />
            <FieldError>{errs.category?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errs.description ? true : undefined} className="@3xl/main:col-span-2">
            <FieldLabel htmlFor={`${uid}-t-description`}>{t.common.fields.description}</FieldLabel>
            <Input id={`${uid}-t-description`} name="description" defaultValue={values.description} placeholder={text.descriptionPlaceholder} />
            <FieldError>{errs.description?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errs.stack_name ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-t-stack`}>{text.stackName}</FieldLabel>
            <Input
              id={`${uid}-t-stack`}
              name="stack_name"
              defaultValue={values.stack_name}
              placeholder="my-app"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <FieldDescription>{text.stackNameDescription}</FieldDescription>
            <FieldError>{errs.stack_name?.[0]}</FieldError>
          </Field>
        </div>

        <Field data-invalid={errs.compose ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-t-compose`}>{text.composeFile}</FieldLabel>
          <Textarea
            id={`${uid}-t-compose`}
            name="compose"
            value={compose}
            onChange={(e) => setCompose(e.target.value)}
            className="max-h-[70vh] min-h-80 font-mono text-xs leading-relaxed md:text-xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            required
          />
          <FieldDescription>
            {i18n.rich(text.composeDescription, {
              ask: <code>{"${NAME}"}</code>,
              withDefault: <code>{"${NAME:-default}"}</code>,
              required: <code>{"${NAME:?}"}</code>,
            })}
          </FieldDescription>
          <FieldError>{errs.compose?.[0]}</FieldError>
        </Field>

        <Field data-invalid={errs.env ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-t-env`}>{text.defaultValues}</FieldLabel>
          <Textarea
            id={`${uid}-t-env`}
            name="env"
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            placeholder={text.envPlaceholder}
            className="max-h-[40vh] min-h-24 font-mono text-xs leading-relaxed md:text-xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
          />
          <FieldDescription>{text.envDescription}</FieldDescription>
          <FieldError>{errs.env?.[0]}</FieldError>
        </Field>

        <div className="flex flex-wrap items-center gap-1.5 text-sm" data-testid="template-variables">
          <span className="text-muted-foreground">{text.asksFor}</span>
          {variables.length ? (
            variables.map((v) => (
              <Badge key={v.name} variant={v.type === "password" ? "secondary" : "outline"} className="font-mono">
                {v.name}
                {v.default ? `=${v.type === "password" ? "•••" : v.default}` : ""}
              </Badge>
            ))
          ) : (
            <span className="text-muted-foreground">{text.noVariables}</span>
          )}
        </div>

        {state.error && state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}

        <Field orientation="horizontal">
          <Button type="submit" disabled={pending}>
            <SaveIcon data-icon="inline-start" />
            {pending ? t.common.status.saving : text.save}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
