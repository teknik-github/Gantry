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
import { DEFAULT_COMPOSE_PATH, DEFAULT_GIT_REF, MAX_POLL_MINUTES, webhookPath } from "@/lib/git-stacks"
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
  return (
    <>
      <Field data-invalid={errs.url ? true : undefined}>
        <FieldLabel htmlFor={`${uid}-git-url`}>Repository URL</FieldLabel>
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
        <FieldDescription>HTTPS only. Put credentials in the fields below, not in the URL.</FieldDescription>
        <FieldError>{errs.url?.[0]}</FieldError>
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field data-invalid={errs.ref ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-git-ref`}>Branch, tag or commit</FieldLabel>
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
          <FieldLabel htmlFor={`${uid}-git-path`}>Compose file path</FieldLabel>
          <Input
            id={`${uid}-git-path`}
            name="composePath"
            defaultValue={values.composePath ?? DEFAULT_COMPOSE_PATH}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errs.composePath ? true : undefined}
          />
          <FieldDescription>Relative to the repository root, e.g. compose.yaml or deploy/prod.yml.</FieldDescription>
          <FieldError>{errs.composePath?.[0]}</FieldError>
        </Field>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field data-invalid={errs.username ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-git-user`}>Username</FieldLabel>
          <Input
            id={`${uid}-git-user`}
            name="username"
            defaultValue={values.username ?? ""}
            placeholder={hasCredentials ? "(stored, unchanged)" : "optional"}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errs.username ? true : undefined}
          />
          <FieldError>{errs.username?.[0]}</FieldError>
        </Field>
        <Field data-invalid={errs.token ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-git-token`}>Access token</FieldLabel>
          <Input
            id={`${uid}-git-token`}
            name="token"
            type="password"
            placeholder={hasCredentials ? "(stored, unchanged)" : "optional"}
            autoComplete="new-password"
            aria-invalid={errs.token ? true : undefined}
          />
          <FieldDescription>
            For private repositories: a read-only token (GitHub fine-grained token with Contents: read, GitLab
            read_repository, Gitea read:repository). Stored encrypted and never shown again.
          </FieldDescription>
          <FieldError>{errs.token?.[0]}</FieldError>
        </Field>
      </div>
      <Field data-invalid={errs.pollMinutes ? true : undefined} className="max-w-xs">
        <FieldLabel htmlFor={`${uid}-git-poll`}>Check for new commits every (minutes)</FieldLabel>
        <Input
          id={`${uid}-git-poll`}
          name="pollMinutes"
          type="number"
          min={0}
          max={MAX_POLL_MINUTES}
          defaultValue={values.pollMinutes ?? "0"}
          aria-invalid={errs.pollMinutes ? true : undefined}
        />
        <FieldDescription>0 = off. New commits are pulled and redeployed automatically.</FieldDescription>
        <FieldError>{errs.pollMinutes?.[0]}</FieldError>
      </Field>
    </>
  )
}

/** New stack from a Git repository (works before hydration; see StackEditor). */
export function GitStackForm() {
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
          <FieldLabel htmlFor={`${uid}-git-name`}>Name</FieldLabel>
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
          <FieldDescription>Used as the compose project name. Lowercase letters, digits, - and _.</FieldDescription>
          <FieldError>{errs.name?.[0]}</FieldError>
        </Field>

        <SourceFields uid={uid} errs={errs} values={values} />

        <Field data-invalid={errs.env ? true : undefined}>
          <FieldLabel htmlFor={`${uid}-git-env`}>Environment variables</FieldLabel>
          <Textarea
            id={`${uid}-git-env`}
            name="env"
            defaultValue={values.env ?? ""}
            placeholder={"# .env, used for ${VARIABLE} substitution\nTAG=latest"}
            className="max-h-[40vh] min-h-24 font-mono text-xs leading-relaxed md:text-xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            aria-invalid={errs.env ? true : undefined}
          />
          <FieldDescription>
            Kept in Gantry (not in the repository) and used for <code>${"{VARIABLE}"}</code> substitution in the
            compose file.
          </FieldDescription>
          <FieldError>{errs.env?.[0]}</FieldError>
        </Field>

        {state.error && state.fieldErrors ? <FieldError>{state.error}</FieldError> : null}

        <Field orientation="horizontal" className="flex-wrap">
          <Button type="submit" name="intent" value="deploy" disabled={pending} onClick={() => setIntent("deploy")}>
            <RocketIcon data-icon="inline-start" />
            {pending && intent === "deploy" ? "Cloning & deploying…" : "Create & deploy"}
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
            {pending && intent === "save" ? "Cloning…" : "Create"}
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
  const [clear, setClear] = React.useState(false)
  const uid = React.useId()
  return (
    <FormDialog
      trigger={
        <Button size="sm" variant="outline">
          <PencilIcon data-icon="inline-start" />
          Edit repository
        </Button>
      }
      title="Repository settings"
      description="The new settings are fetched before they are saved. Running containers change on the next deploy."
      submitLabel="Fetch & save"
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
              Remove the stored credentials
            </Label>
          ) : null}
        </FieldGroup>
      )}
    </FormDialog>
  )
}

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toast.error("Couldn't copy")
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
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <code data-testid={testId} className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button type="button" size="sm" variant="outline" onClick={() => copy(value, label)} aria-label={`Copy ${label.toLowerCase()}`}>
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
        <p className="text-muted-foreground">
          Let GitHub, GitLab, Gitea/Forgejo or any CI call Gantry when you push to <Mono>{gitRef}</Mono>; the stack is
          then pulled and redeployed.
        </p>
        <Button size="sm" disabled={pending} onClick={() => generate(false)}>
          <WebhookIcon data-icon="inline-start" />
          Enable webhook
        </Button>
      </div>
    )
  }

  const shown = secret ?? "<your secret>"
  return (
    <div className="flex flex-col gap-4 text-sm">
      <CopyField label="Payload URL" value={url} testId="webhook-url" />
      {secret ? (
        <div className="grid gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
          <CopyField label="Secret" value={secret} testId="webhook-secret" />
          <span className="text-xs text-muted-foreground">
            Copy it now: it is stored encrypted and won&apos;t be shown again. Regenerate it if it gets lost.
          </span>
        </div>
      ) : (
        <p className="text-muted-foreground">
          <KeyRoundIcon className="mr-1 inline size-4" />
          The secret is hidden. Regenerate it to see a new one (the old one stops working).
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <ConfirmAction
          title="Regenerate the webhook secret?"
          description="Deliveries signed with the current secret are rejected from now on. Update the secret at your Git provider."
          confirmLabel="Regenerate"
          onConfirm={async () => {
            const res = await enableWebhook(stackId, { regenerate: true })
            if (res.ok && res.secret) setSecret(res.secret)
            return res
          }}
        >
          <Button size="sm" variant="outline" disabled={pending}>
            <KeyRoundIcon data-icon="inline-start" />
            Regenerate secret
          </Button>
        </ConfirmAction>
        <ConfirmAction
          title="Disable the webhook?"
          description="Deliveries to this URL are rejected. Enabling it again creates a new URL and secret."
          confirmLabel="Disable"
          onConfirm={async () => {
            const res = await disableStackWebhook(stackId)
            if (res.ok) setSecret(null)
            return res
          }}
        >
          <Button size="sm" variant="outline" disabled={pending}>
            Disable webhook
          </Button>
        </ConfirmAction>
      </div>

      <Tabs defaultValue="github">
        <TabsList>
          <TabsTrigger value="github">GitHub</TabsTrigger>
          <TabsTrigger value="gitlab">GitLab</TabsTrigger>
          <TabsTrigger value="gitea">Gitea / Forgejo</TabsTrigger>
          <TabsTrigger value="generic">Other / CI</TabsTrigger>
        </TabsList>
        <TabsContent value="github">
          <Steps
            steps={[
              <>Repository → Settings → Webhooks → Add webhook.</>,
              <>
                Payload URL: the URL above. Content type: <Mono>application/json</Mono>.
              </>,
              <>Secret: the secret. Signed with X-Hub-Signature-256 (HMAC-SHA256).</>,
              <>Which events: &quot;Just the push event&quot;. GitHub sends a ping first, which Gantry answers.</>,
            ]}
          />
        </TabsContent>
        <TabsContent value="gitlab">
          <Steps
            steps={[
              <>Project → Settings → Webhooks → Add new webhook.</>,
              <>URL: the URL above. Secret token: the secret (sent as X-Gitlab-Token).</>,
              <>
                Trigger: Push events (optionally limited to <Mono>{gitRef}</Mono>); Tag push events if the stack follows
                a tag. Keep SSL verification on.
              </>,
            ]}
          />
        </TabsContent>
        <TabsContent value="gitea">
          <Steps
            steps={[
              <>Repository → Settings → Webhooks → Add webhook → Gitea (or Forgejo).</>,
              <>
                Target URL: the URL above, method POST, content type <Mono>application/json</Mono>.
              </>,
              <>Secret: the secret (X-Gitea-Signature / X-Forgejo-Signature, HMAC-SHA256).</>,
              <>
                Trigger on: Push events. Branch filter: <Mono>{gitRef}</Mono>.
              </>,
            ]}
          />
        </TabsContent>
        <TabsContent value="generic">
          <Steps
            steps={[
              <>POST to the URL with the secret in an X-Gantry-Token header (or Authorization: Bearer).</>,
              <>
                Optional JSON body <Mono>{`{"ref": "refs/heads/${gitRef}"}`}</Mono>: other refs are ignored. Without a
                ref the stack is redeployed.
              </>,
            ]}
          />
          <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
            {`curl -fsS -X POST -H "X-Gantry-Token: ${shown}" \\\n  ${url}`}
          </pre>
        </TabsContent>
      </Tabs>
      <p className="text-xs text-muted-foreground">
        Pushes to other branches are ignored, and nothing is redeployed when the commit and .env are unchanged.
        Deliveries are answered with 202 at once; the redeploy runs in the background and shows up under Last run.
      </p>
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
