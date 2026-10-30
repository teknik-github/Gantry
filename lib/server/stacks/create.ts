import "server-only"

import { UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import type { CurrentUser } from "@/lib/server/auth/dal"
import type { DockerApi } from "@/lib/server/docker/api"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { findStackByName, getStack, insertStack, PROJECT_LABEL, runStackOperation } from "@/lib/server/stacks"

/**
 * Creates a stack in the current environment and optionally deploys it (the
 * deploy output is stored on the stack, success or not). Call inside
 * runAction with the manager role. Returns the new stack's id.
 */
export async function createStackInCurrentEnvironment(
  ctx: { user: CurrentUser; docker: () => Promise<DockerApi> },
  input: { name: string; compose: string; env: string; deploy: boolean }
): Promise<number> {
  const environment = await getCurrentEnvironment()
  if (!environment) throw new UserError("No Docker environment configured")
  if (await findStackByName(environment.id, input.name)) {
    throw new UserError(`A stack named "${input.name}" already exists in this environment`)
  }
  const api = await ctx.docker()
  // Deploying would take over a project that Gantry doesn't manage.
  const containers = await api.listContainers(true).catch(() => [])
  if (containers.some((c) => c.Labels?.[PROJECT_LABEL] === input.name)) {
    throw new UserError(
      `A compose project named "${input.name}" already exists on this environment. Use Import on the Stacks page, or pick another name.`
    )
  }

  const id = await insertStack({
    environment_id: environment.id,
    name: input.name,
    compose: input.compose,
    env: input.env,
    created_by: ctx.user.username,
  })
  if (input.deploy) {
    const stack = await getStack(id)
    if (!stack) throw new Error("Stack vanished after insert")
    const run = await runStackOperation(stack, api.target, "deploy", ctx.user.username)
    await audit(ctx.user, run.code === 0 ? "stack.deploy" : "stack.deploy.failed", input.name)
  }
  return id
}
