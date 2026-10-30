"use server"

import { redirect } from "next/navigation"
import { z } from "zod"

import { allowHttpLoopback, pollMinutesSchema, validateComposePath, validateRef, validateRepoUrl } from "@/lib/git-stacks"
import { runAction, UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import { updateStackContent, withStackLock, StackBusyError } from "@/lib/server/stacks"
import { auditName, loadStack, operate } from "@/lib/server/stacks/action-helpers"
import { stackDir, OutputBuffer } from "@/lib/server/stacks/compose"
import { ComposePathError, createGitStackInCurrentEnvironment } from "@/lib/server/stacks/create"
import { checkCredentials, GitError, readComposeFile, syncCheckout, type GitCredentials } from "@/lib/server/stacks/git"
import {
  disableWebhook,
  getStackGit,
  GitCredentialsError,
  gitSource,
  setWebhook,
  updateStackGitSource,
} from "@/lib/server/stacks/git-records"
import { normalizeText, stackNameSchema, validateCompose, validateDotenv } from "@/lib/stacks"
import type { ActionState } from "@/lib/validation"

// Server Actions for stacks sourced from Git. All admin-only (runAction
// "admin") and audited. Tokens and webhook secrets are never echoed back in
// `values`; a webhook secret is returned exactly once, when it is created.

const idSchema = z.coerce.number().int().positive()

type SourceFields = { url: string; ref: string; composePath: string; pollMinutes: number }

/** Validates URL, ref, compose path and polling interval from a form. */
function checkSource(formData: FormData, fieldErrors: Record<string, string[]>): SourceFields | null {
  const url = validateRepoUrl(String(formData.get("url") ?? ""), { allowHttpLoopback: allowHttpLoopback() })
  const ref = validateRef(String(formData.get("ref") ?? ""))
  const composePath = validateComposePath(String(formData.get("composePath") ?? ""))
  const poll = pollMinutesSchema.safeParse(String(formData.get("pollMinutes") ?? "0").trim() || "0")
  if (!url.ok) fieldErrors.url = [url.error]
  if (!ref.ok) fieldErrors.ref = [ref.error]
  if (!composePath.ok) fieldErrors.composePath = [composePath.error]
  if (!poll.success) fieldErrors.pollMinutes = [poll.error.issues[0]?.message ?? "Invalid interval"]
  if (!url.ok || !ref.ok || !composePath.ok || !poll.success) return null
  return { url: url.value, ref: ref.value, composePath: composePath.value, pollMinutes: poll.data }
}

/** Form values safe to send back (never the token). */
function echo(formData: FormData, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, String(formData.get(k) ?? "")]))
}

export async function createGitStack(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = echo(formData, ["name", "url", "ref", "composePath", "username", "env", "pollMinutes"])
  const deploy = formData.get("intent") === "deploy"
  const fieldErrors: Record<string, string[]> = {}

  const name = stackNameSchema.safeParse(String(formData.get("name") ?? ""))
  if (!name.success) fieldErrors.name = [name.error.issues[0]?.message ?? "Invalid name"]
  const source = checkSource(formData, fieldErrors)
  const username = String(formData.get("username") ?? "").trim()
  const token = String(formData.get("token") ?? "").trim()
  const credsError = checkCredentials(username, token)
  if (credsError) fieldErrors[username ? "token" : "username"] = [credsError]
  const env = normalizeText(String(formData.get("env") ?? ""))
  const envError = validateDotenv(env)
  if (envError) fieldErrors.env = [envError]
  if (Object.keys(fieldErrors).length || !name.success || !source) {
    return { error: "Please fix the highlighted fields", fieldErrors, values }
  }

  let createdId = 0
  let pathError: string | null = null
  const res = await runAction("admin", "stack.create", `${name.data} (git ${source.url} ${source.ref})`, async (ctx) => {
    try {
      createdId = await createGitStackInCurrentEnvironment(ctx, {
        name: name.data,
        ...source,
        credentials: username ? { username, token } : null,
        env,
        deploy,
      })
    } catch (err) {
      if (err instanceof ComposePathError) pathError = err.message
      throw err
    }
    return `Stack ${name.data} created`
  })
  if (!res.ok) {
    const fe: Record<string, string[]> = {}
    if (res.error && /already exists/.test(res.error)) fe.name = [res.error]
    if (pathError) fe.composePath = [pathError]
    return { ...res, fieldErrors: Object.keys(fe).length ? fe : undefined, values }
  }
  redirect(`/stacks/${createdId}`)
}

/**
 * Changes a Git stack's repository, ref, compose path, credentials or polling
 * interval. The new source is fetched (under the stack's lock) before it is
 * saved, so a broken one is reported and the old one kept. Running containers
 * are not touched until the next deploy.
 */
export async function updateGitSource(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = idSchema.safeParse(formData.get("id"))
  if (!id.success) return { error: "Invalid stack" }
  const fieldErrors: Record<string, string[]> = {}
  const source = checkSource(formData, fieldErrors)
  const username = String(formData.get("username") ?? "").trim()
  const token = String(formData.get("token") ?? "").trim()
  const clear = formData.get("clearCredentials") === "on"
  if (!clear && token) {
    const err = checkCredentials(username, token)
    if (err) fieldErrors[username ? "token" : "username"] = [err]
  }
  if (Object.keys(fieldErrors).length || !source) return { error: "Please fix the highlighted fields", fieldErrors }

  return runAction("admin", "stack.git.update", `${await auditName(id.data)} (${source.url} ${source.ref})`, async () => {
    const stack = await loadStack(id.data)
    const row = await getStackGit(stack.id)
    if (!row) throw new UserError("This stack isn't sourced from Git")

    let previous: GitCredentials | null = null
    try {
      previous = gitSource(row).credentials
    } catch (err) {
      if (!(err instanceof GitCredentialsError)) throw err
      // Unreadable: only replacing or removing them helps.
      if (!token && !clear) throw new UserError(err.message)
    }
    let credentials: GitCredentials | null | "keep" = "keep"
    if (clear) credentials = null
    else if (token) credentials = { username, token }
    else if (previous) {
      // Stored tokens only go to the host they were entered for.
      if (new URL(row.repo_url).host !== new URL(source.url).host) {
        throw new UserError("The repository host changed: enter the token again, or remove the credentials")
      }
      if (username && username !== previous.username) credentials = { username, token: previous.token }
    } else if (username) {
      throw new UserError("Enter the access token for this username")
    }
    const effective = credentials === "keep" ? previous : credentials

    try {
      await withStackLock(stack.id, async () => {
        const dir = stackDir(stack.environment_id, stack.name)
        try {
          await syncCheckout(dir, { url: source.url, ref: source.ref, credentials: effective }, new OutputBuffer())
          const file = await readComposeFile(dir, source.composePath)
          const check = validateCompose(file.text)
          if (!check.ok) throw new UserError(`${source.composePath}: ${check.error}`)
          await updateStackGitSource(stack.id, { ...source, credentials })
          await updateStackContent(stack.id, file.text, stack.env)
        } catch (err) {
          // Put the checkout back on the saved source (best effort; it's refetched on the next pull anyway).
          if (row.commit_sha) {
            await syncCheckout(dir, { url: row.repo_url, ref: row.commit_sha, credentials: previous }, new OutputBuffer()).catch(() => {})
          }
          throw err
        }
      })
    } catch (err) {
      if (err instanceof StackBusyError || err instanceof GitError) throw new UserError(err.message)
      throw err
    }
    return `Repository settings saved (fetched ${source.ref}). Deploy to apply them.`
  })
}

/** Saves a Git stack's .env (the compose file comes from the repository), optionally deploying. */
export async function updateGitStackEnv(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = { env: String(formData.get("env") ?? "") }
  const id = idSchema.safeParse(formData.get("id"))
  if (!id.success) return { error: "Invalid stack", values }
  const deploy = formData.get("intent") === "deploy"
  const env = normalizeText(values.env)
  const envError = validateDotenv(env)
  if (envError) return { error: "Please fix the highlighted fields", fieldErrors: { env: [envError] }, values }

  const res = await runAction("admin", deploy ? "stack.deploy" : "stack.update", await auditName(id.data), async (ctx) => {
    const stack = await loadStack(id.data)
    if (!(await getStackGit(stack.id))) throw new UserError("This stack isn't sourced from Git")
    await updateStackContent(stack.id, stack.compose, env)
    if (!deploy) return `Environment of ${stack.name} saved`
    await audit(ctx.user, "stack.update", stack.name)
    await operate({ ...stack, env }, "deploy", ctx)
    return `${stack.name} saved and deployed`
  })
  return { ...res, values }
}

export type WebhookState = ActionState & { secret?: string }

/** Turns the webhook on (or rotates its secret). The secret is only ever returned here. */
export async function enableWebhook(id: number, opts: { regenerate?: boolean } = {}): Promise<WebhookState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid stack" }
  let secret: string | undefined
  const action = opts.regenerate ? "stack.webhook.regenerate" : "stack.webhook.enable"
  const res = await runAction("admin", action, await auditName(parsed.data), async () => {
    const stack = await loadStack(parsed.data)
    const row = await getStackGit(stack.id)
    if (!row) throw new UserError("Webhooks are only available for Git stacks")
    if (opts.regenerate && !row.webhook_id) throw new UserError("The webhook is not enabled")
    ;({ secret } = await setWebhook(stack.id, { keepId: true }))
    return opts.regenerate ? "New webhook secret generated; update it at your Git provider" : "Webhook enabled"
  })
  return res.ok ? { ...res, secret } : res
}

export async function disableStackWebhook(id: number): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid stack" }
  return runAction("admin", "stack.webhook.disable", await auditName(parsed.data), async () => {
    const stack = await loadStack(parsed.data)
    if (!(await getStackGit(stack.id))) throw new UserError("Webhooks are only available for Git stacks")
    await disableWebhook(stack.id)
    return "Webhook disabled"
  })
}
