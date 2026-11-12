"use server"

import fs from "node:fs/promises"
import path from "node:path"
import { refresh } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { getI18n } from "@/lib/i18n/server"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { expectedEnvironment, inEnvironment, runAction, UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import {
  CONFIG_FILES_LABEL,
  deleteStackRecord,
  findStackByName,
  groupByProject,
  insertStack,
  PROJECT_LABEL,
  runStackOperation,
  StackBusyError,
  updateStackContent,
  WORKING_DIR_LABEL,
} from "@/lib/server/stacks"
import { auditName, loadStack, operate } from "@/lib/server/stacks/action-helpers"
import { selfContainerIds } from "@/lib/server/docker/self"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { createStackInCurrentEnvironment } from "@/lib/server/stacks/create"
import {
  composeProjectSchema,
  EXTERNAL_OPERATIONS,
  ExternalProjectError,
  runExternalOperation,
  type ExternalOperation,
} from "@/lib/server/stacks/external"
import { getStackGit } from "@/lib/server/stacks/git-records"
import { shortSha } from "@/lib/git-stacks"
import { removeStackDir, STACK_OPERATIONS, stackDir, type StackOperation } from "@/lib/server/stacks/compose"
import { MAX_COMPOSE_BYTES, normalizeText, stackNameSchema, validateCompose, validateDotenv } from "@/lib/stacks"
import type { ActionState } from "@/lib/validation"

const idSchema = z.coerce.number().int().positive()

/** Field-level validation shared by create and update. Returns normalized text or errors. */
function checkContent(formData: FormData) {
  const compose = normalizeText(String(formData.get("compose") ?? ""))
  const env = normalizeText(String(formData.get("env") ?? ""))
  const fieldErrors: Record<string, string[]> = {}
  const composeCheck = validateCompose(compose)
  if (!composeCheck.ok) fieldErrors.compose = [composeCheck.error]
  const envError = validateDotenv(env)
  if (envError) fieldErrors.env = [envError]
  return { compose, env, fieldErrors }
}

export async function createStack(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const rawName = String(formData.get("name") ?? "")
  const values = { name: rawName, compose: String(formData.get("compose") ?? ""), env: String(formData.get("env") ?? "") }
  const deploy = formData.get("intent") === "deploy"
  const { t, format } = await getI18n()

  const name = stackNameSchema.safeParse(rawName)
  const { compose, env, fieldErrors } = checkContent(formData)
  if (!name.success) fieldErrors.name = [name.error.issues[0]?.message ?? t.stacks.messages.invalidName]
  if (Object.keys(fieldErrors).length || !name.success) {
    return { error: t.common.errors.fixFields, fieldErrors, values }
  }

  let createdId = 0
  const res = await runAction(inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD))), "stack.create", name.data, async (ctx) => {
    createdId = await createStackInCurrentEnvironment(ctx, { name: name.data, compose, env, deploy })
    return format(t.stacks.messages.created, { name: name.data })
  })

  if (!res.ok) {
    const nameTaken = res.error && /already exists/.test(res.error)
    return { ...res, fieldErrors: nameTaken ? { name: [res.error!] } : undefined, values }
  }
  // The stack page shows the deploy output (successful or not).
  redirect(`/stacks/${createdId}`)
}

export async function updateStack(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values = { compose: String(formData.get("compose") ?? ""), env: String(formData.get("env") ?? "") }
  const { t, format } = await getI18n()
  const id = idSchema.safeParse(formData.get("id"))
  if (!id.success) return { error: t.stacks.messages.invalidStack, values }
  const deploy = formData.get("intent") === "deploy"

  const { compose, env, fieldErrors } = checkContent(formData)
  if (Object.keys(fieldErrors).length) return { error: t.common.errors.fixFields, fieldErrors, values }

  // runAction audits the deploy; the save is audited separately so it's recorded even if the deploy fails.
  const res = await runAction(inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD))), deploy ? "stack.deploy" : "stack.update", await auditName(id.data), async (ctx) => {
    const stack = await loadStack(id.data)
    if (await getStackGit(stack.id)) throw new UserError(t.stacks.messages.composeFromGit)
    await updateStackContent(stack.id, compose, env)
    if (!deploy) return format(t.stacks.messages.saved, { name: stack.name })
    await audit(ctx.user, "stack.update", stack.name)
    await operate({ ...stack, compose, env }, "deploy", ctx)
    return format(t.stacks.messages.savedDeployed, { name: stack.name })
  })
  return { ...res, values }
}

const operationSchema = z.object({
  id: idSchema,
  op: z.enum(STACK_OPERATIONS),
  removeVolumes: z.boolean().optional(),
  force: z.boolean().optional(),
})

/**
 * Runs a compose operation on a stack. For Git stacks "redeploy" fetches the
 * repository first and does nothing when the commit and .env are unchanged,
 * unless `force` is set.
 */
export async function stackOperation(
  id: number,
  op: StackOperation,
  opts: { removeVolumes?: boolean; force?: boolean } = {},
  environmentId?: number
): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = operationSchema.safeParse({ id, op, removeVolumes: opts.removeVolumes, force: opts.force })
  if (!parsed.success) return { error: t.stacks.messages.invalidRequest }
  const { removeVolumes, force } = parsed.data

  const target = `${await auditName(parsed.data.id)}${removeVolumes ? " (with volumes)" : ""}${force ? " (forced)" : ""}`
  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), `stack.${parsed.data.op}`, target, async (ctx) => {
    const stack = await loadStack(parsed.data.id)
    const run = await operate(stack, parsed.data.op, ctx, { removeVolumes: removeVolumes === true, force: force === true })
    if (run.skipped) return format(t.stacks.messages.nothingToRedeploy, { name: stack.name, sha: shortSha(run.commit?.sha) })
    const done = t.stacks.messages.operationDone[parsed.data.op]
    return run.commit
      ? format(t.stacks.messages.operationAt, { name: stack.name, done, sha: shortSha(run.commit.sha) })
      : format(t.stacks.messages.operation, { name: stack.name, done })
  })
}

/** Takes the stack down (optionally with its volumes), then forgets it. */
export async function deleteStack(
  id: number,
  opts: { removeVolumes?: boolean } = {},
  environmentId?: number
): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: t.stacks.messages.invalidStack }

  const target = `${await auditName(parsed.data)}${opts.removeVolumes ? " (with volumes)" : ""}`
  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "stack.delete", target, async (ctx) => {
    const stack = await loadStack(parsed.data)
    const api = await ctx.docker()
    let run
    try {
      run = await runStackOperation(stack, api.target, "down", ctx.user.username, {
        removeVolumes: opts.removeVolumes === true,
      })
    } catch (err) {
      if (err instanceof StackBusyError) throw new UserError(err.message)
      throw err
    }
    if (run.code !== 0) {
      // A broken compose file can't be taken down; only block deletion if something is still deployed.
      const left = (await api.listContainers(true)).filter((c) => c.Labels?.[PROJECT_LABEL] === stack.name)
      if (left.length > 0) {
        await audit(ctx.user, "stack.down.failed", stack.name)
        refresh()
        throw new UserError(format(t.stacks.messages.downFailed, { name: stack.name }))
      }
    }
    await deleteStackRecord(stack.id)
    await removeStackDir(stackDir(stack.environment_id, stack.name)).catch((err) =>
      console.error(`[gantry] could not remove stack directory for ${stack.name}`, err)
    )
    return format(t.stacks.messages.deleted, { name: stack.name })
  })
}

/**
 * Creates a stack record for a compose project that was started outside
 * Gantry, from the compose file recorded in its container labels. Only works
 * when that file is readable from where Gantry runs. Administrators only:
 * it reads a path named by container labels, which anyone who can create
 * containers controls.
 */
export async function importProject(project: string): Promise<ActionState> {
  const { t, format } = await getI18n()
  const msg = t.stacks.messages
  const name = stackNameSchema.safeParse(project)
  if (!name.success) return { error: msg.importBadName }

  return runAction("admin", "stack.import", name.data, async (ctx) => {
    // The labels naming the compose file come from the daemon; only trust them
    // for the local socket, whose files are the ones Gantry can see.
    const environment = await getCurrentEnvironment()
    if (environment?.type !== "socket") {
      throw new UserError(msg.importSocketOnly)
    }
    const environmentId = environment.id
    if (await findStackByName(environmentId, name.data)) {
      throw new UserError(format(msg.importExists, { name: name.data }))
    }

    const api = await ctx.docker()
    const containers = groupByProject(await api.listContainers(true)).get(name.data) ?? []
    if (containers.length === 0) throw new UserError(format(msg.importNoContainers, { name: name.data }))

    const labels = containers[0].Labels ?? {}
    const files = (labels[CONFIG_FILES_LABEL] ?? "").split(",").map((f) => f.trim()).filter(Boolean)
    if (files.length !== 1) {
      throw new UserError(files.length === 0 ? msg.importNoFile : msg.importSeveralFiles)
    }
    const file = files[0]
    if (!path.isAbsolute(file) || !/\.ya?ml$/i.test(file)) throw new UserError(format(msg.importUnsupportedPath, { file }))

    let compose: string
    try {
      const stat = await fs.stat(/* turbopackIgnore: true */ file)
      if (!stat.isFile()) throw new Error("not a file")
      if (stat.size > MAX_COMPOSE_BYTES) throw new UserError(msg.importTooLarge)
      compose = normalizeText(await fs.readFile(/* turbopackIgnore: true */ file, "utf8"))
    } catch (err) {
      if (err instanceof UserError) throw err
      throw new UserError(format(msg.importUnreadable, { file }))
    }
    const check = validateCompose(compose)
    if (!check.ok) throw new UserError(`${file}: ${check.error}`)

    // Carry over the project's .env (compose's default env file) when there is one.
    let env = ""
    const workingDir = labels[WORKING_DIR_LABEL]
    if (workingDir && path.isAbsolute(workingDir)) {
      const text = await fs.readFile(path.join(/* turbopackIgnore: true */ workingDir, ".env"), "utf8").catch(() => "")
      if (text && !validateDotenv(normalizeText(text))) env = normalizeText(text)
    }

    await insertStack({ environment_id: environmentId, name: name.data, compose, env, created_by: ctx.user.username })
    return format(msg.imported, { name: name.data })
  })
}

/**
 * Start, stop, restart, redeploy (pull & recreate) or remove a compose project
 * Gantry doesn't manage, through its containers (lib/server/stacks/external.ts).
 * Same rights as the matching container actions: operate for start/stop/
 * restart, manage for redeploy and remove.
 */
export async function externalProjectOperation(
  project: string,
  op: ExternalOperation,
  opts: { removeVolumes?: boolean } = {},
  environmentId?: number
): Promise<ActionState> {
  const { t, format } = await getI18n()
  const msg = t.stacks.messages
  const parsed = z
    .object({ project: composeProjectSchema, op: z.enum(EXTERNAL_OPERATIONS), removeVolumes: z.boolean().optional() })
    .safeParse({ project, op, removeVolumes: opts.removeVolumes })
  if (!parsed.success) return { error: msg.invalidRequest }
  const { project: name, removeVolumes } = parsed.data
  const level = parsed.data.op === "redeploy" || parsed.data.op === "remove" ? "manage" : "operate"
  const target = `${name}${removeVolumes ? " (with volumes)" : ""}`

  return runAction(inEnvironment(level, expectedEnvironment(environmentId)), `project.${parsed.data.op}`, target, async (ctx) => {
    const environment = await getCurrentEnvironment()
    if (environment && (await findStackByName(environment.id, name))) {
      throw new UserError(format(msg.projectManaged, { name }))
    }
    let result
    try {
      result = await runExternalOperation(await ctx.docker(), name, parsed.data.op, {
        removeVolumes: removeVolumes === true,
        self: selfContainerIds(),
      })
    } catch (err) {
      if (err instanceof ExternalProjectError) {
        throw new UserError(
          err.reason === "notFound" ? format(msg.importNoContainers, { name }) : t.containers.selfContainer
        )
      }
      throw err
    }
    const done = format(msg.projectDone[parsed.data.op], { name, count: result.done, unchanged: result.unchanged })
    if (result.failures.length > 0) {
      throw new UserError(format(msg.projectPartial, { done, failures: result.failures.join("; ") }))
    }
    return done
  })
}
