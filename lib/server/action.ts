import "server-only"

import { refresh } from "next/cache"

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
