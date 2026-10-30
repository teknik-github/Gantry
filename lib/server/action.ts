import "server-only"

import { refresh } from "next/cache"
import { redirect } from "next/navigation"

import { BULK_LIMIT, bulkSummary, runBulk } from "@/lib/bulk"
import { ENVIRONMENT_SWITCHED, NO_ENVIRONMENT_ASSIGNED } from "@/lib/messages"
import { allows, ROLE_LABELS, roleFor, type EnvironmentPermission } from "@/lib/permissions"
import { audit } from "@/lib/server/audit"
import { getCurrentUser, requireUser, type CurrentUser } from "@/lib/server/auth/dal"
import type { Environment } from "@/lib/server/db/schema"
import { DockerError } from "@/lib/server/docker/client"
import { getCurrentEnvironment, getDocker, getEnvironmentRole } from "@/lib/server/environments"
import { KubeError } from "@/lib/server/kubernetes/client"
import type { DockerApi } from "@/lib/server/docker/api"
import type { ActionState } from "@/lib/validation"

/**
 * What an action needs:
 * - "user": any signed-in user, nothing environment-related (own account);
 * - "admin": a global administrator (users, environments, registries...);
 * - "view" | "operate" | "manage": that right in the CURRENT environment
 *   (lib/permissions.ts). Use inEnvironment() to also pin the environment
 *   the page was rendered for.
 */
export type Permission = "user" | "admin" | EnvironmentPermission | EnvironmentScope
export type EnvironmentScope = { need: EnvironmentPermission; environmentId?: number }

/**
 * An environment permission bound to the environment the page was rendered
 * for (sent by the client, see components/gantry/environment-scope.tsx).
 * The action is refused when the selected environment changed since, e.g.
 * in another tab, instead of running on another host.
 */
export function inEnvironment(need: EnvironmentPermission, environmentId: number | undefined): EnvironmentScope {
  return { need, environmentId }
}

/** Parses the environment id a client sent (form field or argument); undefined if absent or invalid. */
export function expectedEnvironment(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

type Authorized = { user: CurrentUser; environment: Environment | null; expectedId?: number }

/**
 * The signed-in user if they have `permission`; denies anything else.
 * Environment permissions are checked against the user's role in the
 * current environment (administrators have every right everywhere).
 */
export async function authorize(permission: Permission): Promise<Authorized | { error: string }> {
  const user = await getCurrentUser()
  // Server Actions and pages are cookie sessions only; tokens are for /api/*.
  if (!user || user.via !== "session") return { error: "Your session has expired. Please sign in again." }
  if (permission === "user") return { user, environment: null }
  if (permission === "admin") {
    return user.role === "admin" ? { user, environment: null } : { error: "Only administrators can do this." }
  }

  const scope = typeof permission === "string" ? { need: permission } : permission
  const environment = await getCurrentEnvironment()
  if (scope.environmentId !== undefined && environment?.id !== scope.environmentId) {
    return { error: environment || user.role === "admin" ? ENVIRONMENT_SWITCHED : NO_ENVIRONMENT_ASSIGNED }
  }
  if (user.role === "admin") return { user, environment, expectedId: scope.environmentId }
  if (!environment) return { error: NO_ENVIRONMENT_ASSIGNED }
  const role = await getEnvironmentRole()
  if (!allows(user.role, role === "admin" ? null : role, scope.need)) {
    return { error: `This needs the ${ROLE_LABELS[roleFor(scope.need)].toLowerCase()} role in ${environment.name}.` }
  }
  return { user, environment, expectedId: scope.environmentId }
}

/**
 * For pages: the signed-in user if they have `permission` in the current
 * environment (or are an administrator); others are sent to the dashboard.
 */
export async function requirePermission(permission: EnvironmentPermission): Promise<CurrentUser> {
  const user = await requireUser()
  const res = await authorize(permission)
  if ("error" in res) redirect("/dashboard")
  return user
}

/**
 * Wraps a Server Action: re-authenticates (never trust the proxy alone),
 * enforces the permission, audits, maps Docker errors to messages and
 * refreshes the router so the UI shows the new state.
 *
 * Kubernetes actions get their client from getKube() inside `fn`; its
 * KubeErrors are shown like Docker errors.
 */
export async function runAction(
  permission: Permission,
  auditAction: string,
  auditTarget: string,
  fn: (ctx: { user: CurrentUser; docker: () => Promise<DockerApi> }) => Promise<string | void>
): Promise<ActionState> {
  const auth = await authorize(permission)
  if ("error" in auth) return auth
  const { user, expectedId } = auth

  try {
    const message = await fn({ user, docker: () => getDocker(expectedId) })
    await audit(user, auditAction, auditTarget)
    refresh()
    return { ok: true, message: message || undefined }
  } catch (err) {
    if (err instanceof DockerError || err instanceof KubeError) return { error: err.message }
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
  opts: {
    verb: string
    noun: string
    label: (item: T) => string
    auditTarget?: (item: T) => string
    /** Objects handled at once (default 4). */
    concurrency?: number
  },
  fn: (item: T, docker: DockerApi) => Promise<void>
): Promise<ActionState> {
  const auth = await authorize(permission)
  if ("error" in auth) return auth
  const { user, expectedId } = auth
  if (!items.length) return { error: "Nothing selected" }
  if (items.length > BULK_LIMIT) return { error: `Select at most ${BULK_LIMIT} items at a time` }

  let docker: DockerApi
  try {
    docker = await getDocker(expectedId)
  } catch (err) {
    if (err instanceof DockerError || err instanceof UserError) return { error: err.message }
    console.error(`[gantry] action ${auditAction} failed`, err)
    return { error: "Something went wrong. Check the server logs." }
  }

  const result = await runBulk(items, (item) => fn(item, docker), {
    concurrency: opts.concurrency,
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
