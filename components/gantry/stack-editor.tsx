"use client"

import * as React from "react"
import { useActionState } from "react"
import { RocketIcon, SaveIcon } from "lucide-react"
import { toast } from "sonner"

import { createStack, updateStack } from "@/app/(app)/stacks/actions"
import { updateGitStackEnv } from "@/app/(app)/stacks/git-actions"
import { EnvironmentField } from "@/components/gantry/environment-scope"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { ActionState } from "@/lib/validation"

export const EXAMPLE_COMPOSE = `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
    restart: unless-stopped
`

/**
 * Create/edit form for a stack. Bound with `action=` so it also works before
 * hydration; submitted values come back in the state and are used as
 * defaults, so nothing is lost when React resets the form after an action.
 */
export function StackEditor({
  stack,
  gitComposePath,
}: {
  /** Omit to create a new stack. */
  stack?: { id: number; name: string; compose: string; env: string }
  /** Git stacks: only the .env is edited here; the compose file comes from the repository. */
  gitComposePath?: string
}) {
  const isNew = !stack
  const isGit = Boolean(stack && gitComposePath)
  const [intent, setIntent] = React.useState<"save" | "deploy">("save")
  // The Server Action itself (not a client wrapper) so the form works before hydration.
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    isNew ? createStack : isGit ? updateGitStackEnv : updateStack,
    {}
  )
  React.useEffect(() => {
    if (state.ok) toast.success(state.message ?? "Saved")
    else if (state.error && !state.fieldErrors) toast.error(state.error)
  }, [state])
  const errs = state.fieldErrors ?? {}
  const values = state.values ?? {}
  // Unique ids: Next keeps recently visited pages hidden in the DOM.
  const uid = React.useId()

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <EnvironmentField />
      {stack ? <input type="hidden" name="id" value={stack.id} /> : null}
      <FieldGroup>
        {isNew ? (
          <Field data-invalid={errs.name ? true : undefined} className="max-w-sm">
            <FieldLabel htmlFor={`${uid}-stack-name`}>Name</FieldLabel>
            <Input
              id={`${uid}-stack-name`}
              name="name"
              placeholder="my-app"
              defaultValue={values.name ?? ""}
              autoComplete="off"
              spellCheck={false}
              required
              aria-invalid={errs.name ? true : undefined}
            />
            <FieldDescription>Used as the compose project name. Lowercase letters, digits, - and _.</FieldDescription>
            <FieldError>{errs.name?.[0]}</FieldError>
          </Field>
        ) : null}

        {isGit ? null : (
          <Field data-invalid={errs.compose ? true : undefined}>
            <FieldLabel htmlFor={`${uid}-stack-compose`}>Compose file</FieldLabel>
            <Textarea
              id={`${uid}-stack-compose`}
              name="compose"
              defaultValue={values.compose ?? stack?.compose ?? EXAMPLE_COMPOSE}
              className="max-h-[70vh] min-h-80 font-mono text-xs leading-relaxed md:text-xs"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              wrap="off"
              required
              aria-invalid={errs.compose ? true : undefined}
            />
            <FieldDescription>
              docker-compose.yml. Relative paths resolve from the stack&apos;s folder in Gantry&apos;s data directory.
            </FieldDescription>
            <FieldError>{errs.compose?.[0]}</FieldError>
          </Field>
        )}

        <Field data-invalid={errs.env ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-stack-env`}>Environment variables</FieldLabel>
          <Textarea
            id={`${uid}-stack-env`}
            name="env"
            defaultValue={values.env ?? stack?.env ?? ""}
            placeholder={"# .env, used for ${VARIABLE} substitution\nTAG=latest"}
            className="max-h-[40vh] min-h-24 font-mono text-xs leading-relaxed md:text-xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            aria-invalid={errs.env ? true : undefined}
          />
          {isGit ? (
            <FieldDescription>
              Kept in Gantry, not in the repository (KEY=value per line), and used for <code>${"{VARIABLE}"}</code>{" "}
              substitution in <code>{gitComposePath}</code>. Pass values into containers with{" "}
              <code>environment:</code> entries such as <code>KEY: ${"{KEY}"}</code>.
            </FieldDescription>
          ) : (
            <FieldDescription>
              Written to the stack&apos;s <code>.env</code> (KEY=value per line). Use <code>env_file: .env</code> in a
              service to pass them into containers.
            </FieldDescription>
          )}
          <FieldError>{errs.env?.[0]}</FieldError>
        </Field>

        {state.error && state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}

        <Field orientation="horizontal" className="flex-wrap">
          <Button
            type="submit"
            name="intent"
            value="deploy"
            disabled={pending}
            onClick={() => setIntent("deploy")}
          >
            <RocketIcon data-icon="inline-start" />
            {pending && intent === "deploy" ? "Deploying…" : isNew ? "Create & deploy" : "Save & deploy"}
          </Button>
          <Button
            type="submit"
            name="intent"
            value="save"
            variant="outline"
            disabled={pending}
            onClick={() => setIntent("save")}
          >
            <SaveIcon data-icon="inline-start" />
            {pending && intent === "save" ? "Saving…" : isNew ? "Create" : "Save"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
