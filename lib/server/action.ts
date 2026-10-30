import "server-only"

import { refresh } from "next/cache"

import { BULK_LIMIT, bulkSummary, runBulk } from "@/lib/bulk"
import { audit } from "@/lib/server/audit"
import { getCurrentUser, type CurrentUser } from "@/lib/server/auth/dal"
import { DockerError } from "@/lib/server/docker/client"
import { getDocker } from "@/lib/server/environments"
import type { DockerApi } from "@/lib/server/docker/api"
import type { ActionState } from "@/lib/validation"

type Permission = "operate" | "admin"

/**
 * Wraps a Server Action: re-authenticates (never trust the proxy alone),
 * enforces the role, audits, maps Docker errors to messages and refreshes
 * the router so the UI shows the new state.
 *
 * - "operate": any signed-in user (start/stop/restart...)
 * - "admin": create/remove resources, manage users and environments
 */
export async function runAction(
  permission: Permission,
  auditAction: string,
  auditTarget: string,
  fn: (ctx: { user: CurrentUser; docker: () => Promise<DockerApi> }) => Promise<string | void>
): Promise<ActionState> {
  const user = await getCurrentUser()
  if (!user) return { error: "Your session has expired. Please sign in again." }
  if (permission === "admin" && user.role !== "admin") {
    return { error: "Only administrators can do this." }
  }

  try {
    const message = await fn({ user, docker: getDocker })
    await audit(user, auditAction, auditTarget)
    refresh()
    return { ok: true, message: message || undefined }
  } catch (err) {
    if (err instanceof DockerError) return { error: err.message }
    if (err instanceof UserError) return { error: err.message }
    console.error(`[gantry] action ${auditAction} failed`, err)
    return { error: "Something went wrong. Check the server logs." }
  }
}

/** Throw inside runAction to show a message to the user. */
export class UserError extends Error {}

/**
 * runAction for several objects at once: one auth check, bounded concurrency,
 * one audit entry per object that succeeded and a single refresh. Failures
 * don't stop the rest; the result names them.
 */
export async function runBulkAction<T>(
  permission: Permission,
  auditAction: string,
  items: T[],
  opts: { verb: string; noun: string; label: (item: T) => string; auditTarget?: (item: T) => string },
  fn: (item: T, docker: DockerApi) => Promise<void>
): Promise<ActionState> {
  const user = await getCurrentUser()
  if (!user) return { error: "Your session has expired. Please sign in again." }
  if (permission === "admin" && user.role !== "admin") {
    return { error: "Only administrators can do this." }
  }
  if (!items.length) return { error: "Nothing selected" }
  if (items.length > BULK_LIMIT) return { error: `Select at most ${BULK_LIMIT} items at a time` }

  let docker: DockerApi
  try {
    docker = await getDocker()
  } catch (err) {
    if (err instanceof DockerError || err instanceof UserError) return { error: err.message }
    console.error(`[gantry] action ${auditAction} failed`, err)
    return { error: "Something went wrong. Check the server logs." }
  }

  const result = await runBulk(items, (item) => fn(item, docker), {
    errorMessage: (err) => {
      if (err instanceof DockerError || err instanceof UserError) return err.message
      console.error(`[gantry] action ${auditAction} failed`, err)
      return "unexpected error"
    },
  })
  for (const item of result.done) await audit(user, auditAction, (opts.auditTarget ?? opts.label)(item))
  if (result.done.length) refresh()
  return bulkSummary(result, opts)
}
