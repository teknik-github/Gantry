"use client"

import * as React from "react"
import { useActionState } from "react"
import { CopyIcon, KeyRoundIcon, PencilIcon, RocketIcon, SaveIcon, WebhookIcon } from "lucide-react"
import { toast } from "sonner"

import {
  createGitStack,
  disableStackWebhook,
  enableWebhook,
  updateGitSource,
} from "@/app/(app)/stacks/git-actions"
import { ConfirmAction } from "@/components/gantry/confirm-button"
import { FormDialog } from "@/components/gantry/form-dialog"
import { Mono } from "@/components/gantry/ui"
import { useRunAction } from "@/components/gantry/use-action"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/lib/i18n/client"
import { DEFAULT_COMPOSE_PATH, DEFAULT_GIT_REF, MAX_POLL_MINUTES, webhookPath } from "@/lib/git-stacks"
import type { I18n } from "@/lib/i18n"
import type { ActionState } from "@/lib/validation"

type Errors = Record<string, string[] | undefined>

/** Repository fields shared by the create form and the edit dialog. */
function SourceFields({
  uid,
  errs,
  values,
  hasCredentials,
}: {
  uid: string
  errs: Errors
  values: { url?: string; ref?: string; composePath?: string; username?: string; pollMinutes?: string }
  /** Edit only: credentials are stored (the token is never sent back). */
  hasCredentials?: boolean
}) {
  const { t } = useI18n()
  const text = t.stacks.git
  return (
    <>
      <Field data-invalid={errs.url ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-git-url`}>{text.repositoryUrl}</FieldLabel>
        <Input
          id={`${uid}-git-url`}
          name="url"
          type="url"
          placeholder="https://github.com/owner/repo.git"
          defaultValue={values.url ?? ""}
          autoComplete="off"
          spellCheck={false}
          required
          aria-invalid={errs.url ? true : undefined}
        />
        <FieldDescription>{text.repositoryUrlDescription}</FieldDescription>
        <FieldError>{errs.url?.[0]}</FieldError>
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field data-invalid={errs.ref ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-git-ref`}>{text.ref}</FieldLabel>
          <Input
            id={`${uid}-git-ref`}
            name="ref"
            defaultValue={values.ref ?? DEFAULT_GIT_REF}
            autoComplete="off"
            spellCheck={false}
            required
            aria-invalid={errs.ref ? true : undefined}
          />
          <FieldError>{errs.ref?.[0]}</FieldError>
        </Field>
        <Field data-invalid={errs.composePath ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-git-path`}>{text.composePath}</FieldLabel>
          <Input
            id={`${uid}-git-path`}
            name="composePath"
            defaultValue={values.composePath ?? DEFAULT_COMPOSE_PATH}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errs.composePath ? true : undefined}
          />
          <FieldDescription>{text.composePathDescription}</FieldDescription>
          <FieldError>{errs.composePath?.[0]}</FieldError>
        </Field>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field data-invalid={errs.username ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-git-user`}>{t.common.fields.username}</FieldLabel>
          <Input
            id={`${uid}-git-user`}
            name="username"
            defaultValue={values.username ?? ""}
            placeholder={hasCredentials ? text.storedUnchanged : t.common.status.optional}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errs.username ? true : undefined}
          />
          <FieldError>{errs.username?.[0]}</FieldError>
        </Field>
        <Field data-invalid={errs.token ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-git-token`}>{text.accessToken}</FieldLabel>
          <Input
            id={`${uid}-git-token`}
            name="token"
            type="password"
            placeholder={hasCredentials ? text.storedUnchanged : t.common.status.optional}
            autoComplete="new-password"
            aria-invalid={errs.token ? true : undefined}
          />
          <FieldDescription>{text.tokenDescription}</FieldDescription>
          <FieldError>{errs.token?.[0]}</FieldError>
        </Field>
      </div>
      <Field data-invalid={errs.pollMinutes ? true : undefined} className="max-w-xs">
        <FieldLabel htmlFor={`${uid}-git-poll`}>{text.pollMinutes}</FieldLabel>
        <Input
          id={`${uid}-git-poll`}
          name="pollMinutes"
          type="number"
          min={0}
          max={MAX_POLL_MINUTES}
          defaultValue={values.pollMinutes ?? "0"}
          aria-invalid={errs.pollMinutes ? true : undefined}
        />
        <FieldDescription>{text.pollDescription}</FieldDescription>
        <FieldError>{errs.pollMinutes?.[0]}</FieldError>
      </Field>
    </>
  )
}

/** New stack from a Git repository (works before hydration; see StackEditor). */
export function GitStackForm() {
  const i18n = useI18n()
  const { t } = i18n
  const [intent, setIntent] = React.useState<"save" | "deploy">("save")
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createGitStack, {})
  React.useEffect(() => {
    if (state.error && !state.fieldErrors) toast.error(state.error)
  }, [state])
  const errs = state.fieldErrors ?? {}
  const values = state.values ?? {}
  const uid = React.useId()

  return (
    <form action={formAction} className="flex flex-col gap-5">
      <FieldGroup>
        <Field data-invalid={errs.name ? true : undefined} className="max-w-sm">
          <FieldLabel htmlFor={`${uid}-git-name`}>{t.common.fields.name}</FieldLabel>
          <Input
            id={`${uid}-git-name`}
            name="name"
            placeholder="my-app"
            defaultValue={values.name ?? ""}
            autoComplete="off"
            spellCheck={false}
            required
            aria-invalid={errs.name ? true : undefined}
          />
          <FieldDescription>{t.stacks.editor.nameDescription}</FieldDescription>
          <FieldError>{errs.name?.[0]}</FieldError>
        </Field>

        <SourceFields uid={uid} errs={errs} values={values} />

        <Field data-invalid={errs.env ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-git-env`}>{t.stacks.editor.environmentVariables}</FieldLabel>
          <Textarea
            id={`${uid}-git-env`}
            name="env"
            defaultValue={values.env ?? ""}
            placeholder={i18n.format(t.stacks.editor.envPlaceholder, { variable: "${VARIABLE}" })}
            className="max-h-[40vh] min-h-24 font-mono text-xs leading-relaxed md:text-xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            aria-invalid={errs.env ? true : undefined}
          />
          <FieldDescription>
            {i18n.rich(t.stacks.git.envDescription, { variable: <code>${"{VARIABLE}"}</code> })}
          </FieldDescription>
          <FieldError>{errs.env?.[0]}</FieldError>
        </Field>

        {state.error && state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}

        <Field orientation="horizontal" className="flex-wrap">
          <Button type="submit" name="intent" value="deploy" disabled={pending} onClick={() => setIntent("deploy")}>
            <RocketIcon data-icon="inline-start" />
            {pending && intent === "deploy" ? t.stacks.git.cloningDeploying : t.stacks.editor.createDeploy}
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
            {pending && intent === "save" ? t.stacks.git.cloning : t.common.actions.create}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

/** Dialog to change a Git stack's repository settings. */
export function GitSourceDialog({
  stackId,
  source,
}: {
  stackId: number
  source: { url: string; ref: string; composePath: string; hasCredentials: boolean; pollMinutes: number }
}) {
  const { t } = useI18n()
  const text = t.stacks.git
  const [clear, setClear] = React.useState(false)
  const uid = React.useId()
  return (
    <FormDialog
      trigger={
        <Button size="sm" variant="outline">
          <PencilIcon data-icon="inline-start" />
          {text.editRepository}
        </Button>
      }
      title={text.settingsTitle}
      description={text.settingsDescription}
      submitLabel={text.fetchSave}
      action={updateGitSource}
      className="sm:max-w-2xl"
    >
      {(errs) => (
        <FieldGroup>
          <input type="hidden" name="id" value={stackId} />
          <SourceFields
            uid={uid}
            errs={errs}
            values={{ url: source.url, ref: source.ref, composePath: source.composePath, pollMinutes: String(source.pollMinutes) }}
            hasCredentials={source.hasCredentials}
          />
          {source.hasCredentials ? (
            <Label className="font-normal">
              <Checkbox name="clearCredentials" checked={clear} onCheckedChange={(v) => setClear(v === true)} />
              {text.removeCredentials}
            </Label>
          ) : null}
        </FieldGroup>
      )}
    </FormDialog>
  )
}

function copy(text: string, what: string, i18n: I18n) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(i18n.format(i18n.t.stacks.git.copied, { what })),
    () => toast.error(i18n.t.stacks.git.copyFailed)
  )
}

const noopSubscribe = () => () => {}

/** This page's origin (empty while server rendering). */
function useOrigin() {
  return React.useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => ""
  )
}

function CopyField({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const i18n = useI18n()
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <code data-testid={testId} className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button type="button" size="sm" variant="outline" onClick={() => copy(value, label, i18n)} aria-label={i18n.format(i18n.t.stacks.git.copyLabel, { label: label.toLowerCase() })}>
          <CopyIcon />
        </Button>
      </div>
    </div>
  )
}

/**
 * Webhook settings of a Git stack: enable/disable, the URL, the secret (only
 * right after it was generated) and setup steps per Git provider.
 */
export function WebhookPanel({ stackId, webhookId, gitRef }: { stackId: number; webhookId: string | null; gitRef: string }) {
  const i18n = useI18n()
  const text = i18n.t.stacks.git
  const [pending, run] = useRunAction()
  const [secret, setSecret] = React.useState<string | null>(null)
  const origin = useOrigin()
  const url = webhookId ? `${origin}${webhookPath(webhookId)}` : ""

  const generate = (regenerate: boolean) =>
    run(async () => {
      const res = await enableWebhook(stackId, { regenerate })
      if (res.ok && res.secret) setSecret(res.secret)
      return res
    })

  if (!webhookId) {
    return (
      <div className="flex flex-col items-start gap-3 text-sm">
        <p className="text-muted-foreground">{i18n.rich(text.webhookIntro, { ref: <Mono>{gitRef}</Mono> })}</p>
        <Button size="sm" disabled={pending} onClick={() => generate(false)}>
          <WebhookIcon data-icon="inline-start" />
          {text.enableWebhook}
        </Button>
      </div>
    )
  }

  const shown = secret ?? text.yourSecret
  return (
    <div className="flex flex-col gap-4 text-sm">
      <CopyField label={text.payloadUrl} value={url} testId="webhook-url" />
      {secret ? (
        <div className="grid gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <CopyField label={text.secret} value={secret} testId="webhook-secret" />
          <span className="text-xs text-muted-foreground">{text.copyNow}</span>
        </div>
      ) : (
        <p className="text-muted-foreground">
          <KeyRoundIcon className="mr-1 inline size-4" />
          {text.secretHidden}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <ConfirmAction
          title={text.regenerateTitle}
          description={text.regenerateDescription}
          confirmLabel={text.regenerate}
          onConfirm={async () => {
            const res = await enableWebhook(stackId, { regenerate: true })
            if (res.ok && res.secret) setSecret(res.secret)
            return res
          }}
        >
          <Button size="sm" variant="outline" disabled={pending}>
            <KeyRoundIcon data-icon="inline-start" />
            {text.regenerateSecret}
          </Button>
        </ConfirmAction>
        <ConfirmAction
          title={text.disableTitle}
          description={text.disableDescription}
          confirmLabel={text.disable}
          onConfirm={async () => {
            const res = await disableStackWebhook(stackId)
            if (res.ok) setSecret(null)
            return res
          }}
        >
          <Button size="sm" variant="outline" disabled={pending}>
            {text.disableWebhook}
          </Button>
        </ConfirmAction>
      </div>

      <Tabs defaultValue="github">
        <TabsList>
          <TabsTrigger value="github">GitHub</TabsTrigger>
          <TabsTrigger value="gitlab">GitLab</TabsTrigger>
          <TabsTrigger value="gitea">Gitea / Forgejo</TabsTrigger>
          <TabsTrigger value="generic">{text.otherCi}</TabsTrigger>
        </TabsList>
        <TabsContent value="github">
          <Steps
            steps={[
              text.github.step1,
              i18n.rich(text.github.step2, { type: <Mono>application/json</Mono> }),
              text.github.step3,
              text.github.step4,
            ]}
          />
        </TabsContent>
        <TabsContent value="gitlab">
          <Steps
            steps={[
              text.gitlab.step1,
              text.gitlab.step2,
              i18n.rich(text.gitlab.step3, { ref: <Mono>{gitRef}</Mono> }),
            ]}
          />
        </TabsContent>
        <TabsContent value="gitea">
          <Steps
            steps={[
              text.gitea.step1,
              i18n.rich(text.gitea.step2, { type: <Mono>application/json</Mono> }),
              text.gitea.step3,
              i18n.rich(text.gitea.step4, { ref: <Mono>{gitRef}</Mono> }),
            ]}
          />
        </TabsContent>
        <TabsContent value="generic">
          <Steps
            steps={[
              text.generic.step1,
              i18n.rich(text.generic.step2, { body: <Mono>{`{"ref": "refs/heads/${gitRef}"}`}</Mono> }),
            ]}
          />
          <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
            {`curl -fsS -X POST -H "X-Gantry-Token: ${shown}" \\\n  ${url}`}
          </pre>
        </TabsContent>
      </Tabs>
      <p className="text-xs text-muted-foreground">{text.footer}</p>
    </div>
  )
}

function Steps({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol className="mt-2 grid list-decimal gap-1 pl-5 text-sm text-muted-foreground">
      {steps.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  )
}
