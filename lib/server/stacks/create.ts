import "server-only"

import fs from "node:fs/promises"

import { UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import type { CurrentUser } from "@/lib/server/auth/dal"
import type { Environment } from "@/lib/server/db/schema"
import type { DockerApi } from "@/lib/server/docker/api"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { findStackByName, getStack, insertStack, PROJECT_LABEL, runStackOperation } from "@/lib/server/stacks"
import { OutputBuffer, removeStackDir, stackDir } from "@/lib/server/stacks/compose"
import { ComposeFileError, GitError, readComposeFile, syncCheckout, type GitCredentials } from "@/lib/server/stacks/git"
import { insertStackGit } from "@/lib/server/stacks/git-records"
import { validateCompose } from "@/lib/stacks"

type Ctx = { user: CurrentUser; docker: () => Promise<DockerApi> }

/** The current environment, if `name` is free there (in Gantry and on the Docker host). */
async function environmentForNewStack(ctx: Ctx, name: string): Promise<{ environment: Environment; api: DockerApi }> {
  const environment = await getCurrentEnvironment()
  if (!environment) throw new UserError("No Docker environment configured")
  if (await findStackByName(environment.id, name)) {
    throw new UserError(`A stack named "${name}" already exists in this environment`)
  }
  const api = await ctx.docker()
  // Deploying would take over a project that Gantry doesn't manage.
  const containers = await api.listContainers(true).catch(() => [])
  if (containers.some((c) => c.Labels?.[PROJECT_LABEL] === name)) {
    throw new UserError(
      `A compose project named "${name}" already exists on this environment. Use Import on the Stacks page, or pick another name.`
    )
  }
  return { environment, api }
}

async function deployNew(ctx: Ctx, api: DockerApi, id: number, name: string) {
  const stack = await getStack(id)
  if (!stack) throw new Error("Stack vanished after insert")
  const run = await runStackOperation(stack, api.target, "deploy", ctx.user.username)
  await audit(ctx.user, run.code === 0 ? "stack.deploy" : "stack.deploy.failed", name)
}

/**
 * Creates a stack in the current environment and optionally deploys it (the
 * deploy output is stored on the stack, success or not). Call inside
 * runAction with the manager role. Returns the new stack's id.
 */
export async function createStackInCurrentEnvironment(
  ctx: Ctx,
  input: { name: string; compose: string; env: string; deploy: boolean }
): Promise<number> {
  const { environment, api } = await environmentForNewStack(ctx, input.name)
  const id = await insertStack({
    environment_id: environment.id,
    name: input.name,
    compose: input.compose,
    env: input.env,
    created_by: ctx.user.username,
  })
  if (input.deploy) await deployNew(ctx, api, id, input.name)
  return id
}

// Stack directories being cloned for a new Git stack (no stack id/lock yet).
const globalForCreate = globalThis as unknown as { __gantryGitCreating?: Set<string> }
const creating = (globalForCreate.__gantryGitCreating ??= new Set<string>())

/** Thrown for a compose file problem, so the form can mark the path field. */
export class ComposePathError extends UserError {}

/**
 * Creates a stack from a Git repository: clones the ref into the stack's
 * directory first (so a wrong URL, ref, path or token is reported right
 * away and nothing is stored), then saves it and optionally deploys.
 */
export async function createGitStackInCurrentEnvironment(
  ctx: Ctx,
  input: {
    name: string
    url: string
    ref: string
    composePath: string
    credentials: GitCredentials | null
    env: string
    pollMinutes: number
    deploy: boolean
  }
): Promise<number> {
  const { environment, api } = await environmentForNewStack(ctx, input.name)
  const dir = stackDir(environment.id, input.name)
  if (creating.has(dir)) throw new UserError(`The stack "${input.name}" is already being created`)
  creating.add(dir)
  try {
    // Leftovers of an earlier stack with this name (it has no record any more).
    if (await fs.stat(dir).then(() => true, () => false)) await removeStackDir(dir)
    let compose: string
    try {
      await syncCheckout(dir, { url: input.url, ref: input.ref, credentials: input.credentials }, new OutputBuffer())
      compose = (await readComposeFile(dir, input.composePath)).text
      const check = validateCompose(compose)
      if (!check.ok) throw new ComposePathError(`${input.composePath}: ${check.error}`)
    } catch (err) {
      // Best-effort cleanup; the original error is what the user needs to see.
      await removeStackDir(dir).catch(() => {})
      if (err instanceof ComposeFileError) throw new ComposePathError(err.message)
      if (err instanceof GitError) throw new UserError(err.message)
      throw err
    }

    const id = await insertStack({
      environment_id: environment.id,
      name: input.name,
      compose,
      env: input.env,
      created_by: ctx.user.username,
    })
    await insertStackGit({
      stackId: id,
      url: input.url,
      ref: input.ref,
      composePath: input.composePath,
      credentials: input.credentials,
      pollMinutes: input.pollMinutes,
    })
    if (input.deploy) await deployNew(ctx, api, id, input.name)
    return id
  } finally {
    creating.delete(dir)
  }
}
