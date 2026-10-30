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
            <FieldLabel htmlFor={`${uid}-t-title`}>Title</FieldLabel>
            <Input id={`${uid}-t-title`} name="title" defaultValue={values.title} placeholder="Internal API" required />
            <FieldError>{errs.title?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errs.category ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-t-category`}>Category</FieldLabel>
            <Input id={`${uid}-t-category`} name="category" defaultValue={values.category ?? "Custom"} placeholder="Custom" />
            <FieldError>{errs.category?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errs.description ? true : undefined} className="@3xl/main:col-span-2">
            <FieldLabel htmlFor={`${uid}-t-description`}>Description</FieldLabel>
            <Input id={`${uid}-t-description`} name="description" defaultValue={values.description} placeholder="What it runs" />
            <FieldError>{errs.description?.[0]}</FieldError>
          </Field>
          <Field data-invalid={errs.stack_name ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-t-stack`}>Default stack name</FieldLabel>
            <Input
              id={`${uid}-t-stack`}
              name="stack_name"
              defaultValue={values.stack_name}
              placeholder="my-app"
              autoComplete="off"
              spellCheck={false}
              required
            />
            <FieldDescription>Suggested when deploying; can be changed each time.</FieldDescription>
            <FieldError>{errs.stack_name?.[0]}</FieldError>
          </Field>
        </div>

        <Field data-invalid={errs.compose ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-t-compose`}>Compose file</FieldLabel>
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
            Use <code>{"${NAME}"}</code> for values to ask when deploying, <code>{"${NAME:-default}"}</code> for a
            default and <code>{"${NAME:?}"}</code> for a required one.
          </FieldDescription>
          <FieldError>{errs.compose?.[0]}</FieldError>
        </Field>

        <Field data-invalid={errs.env ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-t-env`}>Default values</FieldLabel>
          <Textarea
            id={`${uid}-t-env`}
            name="env"
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            placeholder={"# .env defaults, e.g.\nHTTP_PORT=8080"}
            className="max-h-[40vh] min-h-24 font-mono text-xs leading-relaxed md:text-xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
          />
          <FieldDescription>
            KEY=value per line. Names containing PASSWORD, SECRET, TOKEN or ending in KEY become password fields
            (generated when left empty).
          </FieldDescription>
          <FieldError>{errs.env?.[0]}</FieldError>
        </Field>

        <div className="flex flex-wrap items-center gap-1.5 text-sm" data-testid="template-variables">
          <span className="text-muted-foreground">Deploy form asks for:</span>
          {variables.length ? (
            variables.map((v) => (
              <Badge key={v.name} variant={v.type === "password" ? "secondary" : "outline"} className="font-mono">
                {v.name}
                {v.default ? `=${v.type === "password" ? "•••" : v.default}` : ""}
              </Badge>
            ))
          ) : (
            <span className="text-muted-foreground">nothing (no variables)</span>
          )}
        </div>

        {state.error && state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}

        <Field orientation="horizontal">
          <Button type="submit" disabled={pending}>
            <SaveIcon data-icon="inline-start" />
            {pending ? "Saving…" : "Save template"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
