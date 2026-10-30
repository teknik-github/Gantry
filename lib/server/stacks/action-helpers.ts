import "server-only"

import { refresh } from "next/cache"

import { UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import type { CurrentUser } from "@/lib/server/auth/dal"
import type { Stack } from "@/lib/server/db/schema"
import type { DockerApi } from "@/lib/server/docker/api"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { getStack, runStackOperation, StackBusyError, type StackRun } from "@/lib/server/stacks"
import type { StackOperation } from "@/lib/server/stacks/compose"

// Shared by the stack Server Actions (app/(app)/stacks/*actions.ts).

/** The current environment, which every stack operation is scoped to. */
export async function currentEnvironmentId() {
  const env = await getCurrentEnvironment()
  if (!env) throw new UserError("No Docker environment configured")
  return env.id
}

/** Stack name for the audit log (falls back to the id). Not an authorization check. */
export async function auditName(id: number) {
  return (await getStack(id))?.name ?? `#${id}`
}

/** Loads a stack and makes sure it belongs to the environment the user is working in. */
export async function loadStack(id: number): Promise<Stack> {
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
export async function operate(
  stack: Stack,
  op: StackOperation,
  ctx: { user: CurrentUser; docker: () => Promise<DockerApi> },
  opts: { removeVolumes?: boolean; force?: boolean } = {}
): Promise<StackRun> {
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
        : `${run.commit === null ? "Updating from Git" : "docker compose"} failed for ${stack.name}. See the output on the stack page.`
    )
  }
  return run
}
