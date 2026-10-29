"use server"

import fs from "node:fs/promises"
import path from "node:path"
import { refresh } from "next/cache"
import { redirect } from "next/navigation"
import { z } from "zod"

import { runAction, UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import type { CurrentUser } from "@/lib/server/auth/dal"
import type { Stack } from "@/lib/server/db/schema"
import type { DockerApi } from "@/lib/server/docker/api"
import { getCurrentEnvironment } from "@/lib/server/environments"
import {
  CONFIG_FILES_LABEL,
  deleteStackRecord,
  findStackByName,
  getStack,
  groupByProject,
  insertStack,
  PROJECT_LABEL,
  runStackOperation,
  StackBusyError,
  updateStackContent,
  WORKING_DIR_LABEL,
} from "@/lib/server/stacks"
import { removeStackDir, STACK_OPERATIONS, stackDir, type StackOperation } from "@/lib/server/stacks/compose"
import { MAX_COMPOSE_BYTES, normalizeText, stackNameSchema, validateCompose, validateDotenv } from "@/lib/stacks"
import type { ActionState } from "@/lib/validation"

const idSchema = z.coerce.number().int().positive()

const OP_LABELS: Record<StackOperation, string> = {
  deploy: "deployed",
  redeploy: "pulled and redeployed",
  start: "started",
  stop: "stopped",
  restart: "restarted",
  down: "taken down",
}

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

/** The current environment, which every stack operation is scoped to. */
async function currentEnvironmentId() {
  const env = await getCurrentEnvironment()
  if (!env) throw new UserError("No Docker environment configured")
  return env.id
}

/** Stack name for the audit log (falls back to the id). Not an authorization check. */
async function auditName(id: number) {
  return (await getStack(id))?.name ?? `#${id}`
}

/** Loads a stack and makes sure it belongs to the environment the user is working in. */
async function loadStack(id: number): Promise<Stack> {
  const stack = await getStack(id)
  if (!stack) throw new UserError("Stack not found")
  if (stack.environment_id !== (await currentEnvironmentId())) {
    throw new UserError("This stack belongs to another environment. Switch to it first.")
  }
  return stack
}

/**
 * Runs a compose operation; on failure records an audit entry, refreshes the
 * page so the stored output shows, and reports the error.
 */
async function operate(
  stack: Stack,
  op: StackOperation,
  ctx: { user: CurrentUser; docker: () => Promise<DockerApi> },
  opts: { removeVolumes?: boolean } = {}
) {
  const { target } = await ctx.docker()
  let run
  try {
    run = await runStackOperation(stack, target, op, ctx.user.username, opts)
  } catch (err) {
    if (err instanceof StackBusyError) throw new UserError(err.message)
    throw err
  }
  if (run.code !== 0) {
    await audit(ctx.user, `stack.${op}.failed`, stack.name)
    refresh()
    throw new UserError(
      run.timedOut
        ? `docker compose timed out for ${stack.name}. See the output on the stack page.`
        : `docker compose failed for ${stack.name}. See the output on the stack page.`
    )
  }
  return run
}

export async function createStack(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const rawName = String(formData.get("name") ?? "")
  const values = { name: rawName, compose: String(formData.get("compose") ?? ""), env: String(formData.get("env") ?? "") }
  const deploy = formData.get("intent") === "deploy"

  const name = stackNameSchema.safeParse(rawName)
  const { compose, env, fieldErrors } = checkContent(formData)
  if (!name.success) fieldErrors.name = [name.error.issues[0]?.message ?? "Invalid name"]
  if (Object.keys(fieldErrors).length || !name.success) {
    return { error: "Please fix the highlighted fields", fieldErrors, values }
  }

  let createdId = 0
  const res = await runAction("admin", "stack.create", name.data, async (ctx) => {
    const environmentId = await currentEnvironmentId()
    if (await findStackByName(environmentId, name.data)) {
      throw new UserError(`A stack named "${name.data}" already exists in this environment`)
    }
    const api = await ctx.docker()
    // Deploying would take over a project that Gantry doesn't manage.
    const containers = await api.listContainers(true).catch(() => [])
    if (containers.some((c) => c.Labels?.[PROJECT_LABEL] === name.data)) {
      throw new UserError(
        `A compose project named "${name.data}" already exists on this environment. Use Import on the Stacks page, or pick another name.`
      )
    }

    createdId = await insertStack({
      environment_id: environmentId,
      name: name.data,
      compose,
      env,
      created_by: ctx.user.username,
    })
    if (!deploy) return `Stack ${name.data} created`

    const stack = await getStack(createdId)
    if (!stack) throw new Error("Stack vanished after insert")
    const run = await runStackOperation(stack, api.target, "deploy", ctx.user.username)
    await audit(ctx.user, run.code === 0 ? "stack.deploy" : "stack.deploy.failed", name.data)
    return `Stack ${name.data} created`
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
  const id = idSchema.safeParse(formData.get("id"))
  if (!id.success) return { error: "Invalid stack", values }
  const deploy = formData.get("intent") === "deploy"

  const { compose, env, fieldErrors } = checkContent(formData)
  if (Object.keys(fieldErrors).length) return { error: "Please fix the highlighted fields", fieldErrors, values }

  // runAction audits the deploy; the save is audited separately so it's recorded even if the deploy fails.
  const res = await runAction("admin", deploy ? "stack.deploy" : "stack.update", await auditName(id.data), async (ctx) => {
    const stack = await loadStack(id.data)
    await updateStackContent(stack.id, compose, env)
    if (!deploy) return `Stack ${stack.name} saved`
    await audit(ctx.user, "stack.update", stack.name)
    await operate({ ...stack, compose, env }, "deploy", ctx)
    return `Stack ${stack.name} saved and deployed`
  })
  return { ...res, values }
}

const operationSchema = z.object({
  id: idSchema,
  op: z.enum(STACK_OPERATIONS),
  removeVolumes: z.boolean().optional(),
})

export async function stackOperation(
  id: number,
  op: StackOperation,
  opts: { removeVolumes?: boolean } = {}
): Promise<ActionState> {
  const parsed = operationSchema.safeParse({ id, op, removeVolumes: opts.removeVolumes })
  if (!parsed.success) return { error: "Invalid request" }
  const { removeVolumes } = parsed.data

  const target = `${await auditName(parsed.data.id)}${removeVolumes ? " (with volumes)" : ""}`
  return runAction("admin", `stack.${parsed.data.op}`, target, async (ctx) => {
    const stack = await loadStack(parsed.data.id)
    await operate(stack, parsed.data.op, ctx, { removeVolumes: removeVolumes === true })
    return `${stack.name} ${OP_LABELS[parsed.data.op]}`
  })
}

/** Takes the stack down (optionally with its volumes), then forgets it. */
export async function deleteStack(id: number, opts: { removeVolumes?: boolean } = {}): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid stack" }

  const target = `${await auditName(parsed.data)}${opts.removeVolumes ? " (with volumes)" : ""}`
  return runAction("admin", "stack.delete", target, async (ctx) => {
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
        throw new UserError(
          `Could not take ${stack.name} down, so it was not deleted. See the output on the stack page.`
        )
      }
    }
    await deleteStackRecord(stack.id)
    await removeStackDir(stackDir(stack.environment_id, stack.name)).catch((err) =>
      console.error(`[gantry] could not remove stack directory for ${stack.name}`, err)
    )
    return `Stack ${stack.name} deleted`
  })
}

/**
 * Creates a stack record for a compose project that was started outside
 * Gantry, from the compose file recorded in its container labels. Only works
 * when that file is readable from where Gantry runs.
 */
export async function importProject(project: string): Promise<ActionState> {
  const name = stackNameSchema.safeParse(project)
  if (!name.success) return { error: "This project name can't be used for a Gantry stack" }

  return runAction("admin", "stack.import", name.data, async (ctx) => {
    const environmentId = await currentEnvironmentId()
    if (await findStackByName(environmentId, name.data)) {
      throw new UserError(`A stack named "${name.data}" already exists in this environment`)
    }

    const api = await ctx.docker()
    const containers = groupByProject(await api.listContainers(true)).get(name.data) ?? []
    if (containers.length === 0) throw new UserError(`No containers found for project "${name.data}"`)

    const labels = containers[0].Labels ?? {}
    const files = (labels[CONFIG_FILES_LABEL] ?? "").split(",").map((f) => f.trim()).filter(Boolean)
    if (files.length !== 1) {
      throw new UserError(
        files.length === 0
          ? "The project's containers don't record their compose file."
          : "Projects made of several compose files can't be imported. Create a stack and paste the merged file (docker compose config)."
      )
    }
    const file = files[0]
    if (!path.isAbsolute(file) || !/\.ya?ml$/i.test(file)) throw new UserError(`Unsupported compose file path: ${file}`)

    let compose: string
    try {
      const stat = await fs.stat(/* turbopackIgnore: true */ file)
      if (!stat.isFile()) throw new Error("not a file")
      if (stat.size > MAX_COMPOSE_BYTES) throw new UserError("The compose file is too large to import")
      compose = normalizeText(await fs.readFile(/* turbopackIgnore: true */ file, "utf8"))
    } catch (err) {
      if (err instanceof UserError) throw err
      throw new UserError(
        `Gantry can't read ${file}. When Gantry runs in a container it only sees its own filesystem; create the stack by pasting the file instead.`
      )
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
    return `Imported ${name.data}`
  })
}
