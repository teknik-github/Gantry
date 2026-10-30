import "server-only"

import { cache } from "react"
import { cookies, headers } from "next/headers"

import { ENVIRONMENT_SWITCHED, NO_ENVIRONMENT_ASSIGNED } from "@/lib/messages"
import { NO_PERMISSIONS, permissionsFor, type EnvironmentRole, type Permissions } from "@/lib/permissions"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { ENV_COOKIE } from "@/lib/server/auth/token"
import { getDb } from "@/lib/server/db"
import type { Environment } from "@/lib/server/db/schema"
import { docker } from "@/lib/server/docker/api"
import { DockerError } from "@/lib/server/docker/client"
import { environmentRoleFor, environmentsForUser } from "@/lib/server/environment-access"
import { credentialsForImage } from "@/lib/server/registries"
import { environmentTarget } from "@/lib/server/environment-target"

export { environmentTarget, type EnvironmentConnection } from "@/lib/server/environment-target"

/**
 * Environments the signed-in user may use: all of them for administrators,
 * only granted ones for standard users, none without a session. Every
 * environment lookup goes through here, so access control is enforced in one
 * place. Rows carry the TLS columns still encrypted; never send them to the
 * browser (pick id/name/type/url).
 */
export const listEnvironments = cache(async (): Promise<Environment[]> => {
  const user = await getCurrentUser()
  if (!user) return []
  return environmentsForUser(await getDb(), user)
})

/** API clients pick the environment with this header (an id); the cookie works too. */
export const ENVIRONMENT_HEADER = "x-gantry-environment"

/**
 * The environment selected via the env cookie, falling back to the first
 * allowed one. API token requests may name one with the X-Gantry-Environment
 * header instead; naming one they can't use gives null rather than another.
 */
export const getCurrentEnvironment = cache(async (): Promise<Environment | null> => {
  const envs = await listEnvironments()
  const user = await getCurrentUser()
  if (user?.via === "token") {
    const wanted = (await headers()).get(ENVIRONMENT_HEADER)
    if (wanted) return envs.find((e) => String(e.id) === wanted.trim()) ?? null
  }
  const selected = Number((await cookies()).get(ENV_COOKIE)?.value)
  return envs.find((e) => e.id === selected) ?? envs[0] ?? null
})

/** The signed-in user's role in the current environment: "admin" for administrators, null without access. */
export const getEnvironmentRole = cache(async (): Promise<EnvironmentRole | "admin" | null> => {
  const user = await getCurrentUser()
  if (!user) return null
  if (user.role === "admin") return "admin"
  const env = await getCurrentEnvironment()
  return env ? environmentRoleFor(await getDb(), user.id, env.id) : null
})

/**
 * What the signed-in user may do in the current environment, for hiding UI
 * they can't use. Enforcement is in runAction/authorize (lib/server/action.ts)
 * and the route handlers (lib/server/api-auth.ts).
 */
export const getPermissions = cache(async (): Promise<Permissions> => {
  const user = await getCurrentUser()
  if (!user) return NO_PERMISSIONS
  const role = await getEnvironmentRole()
  return permissionsFor(user.role, role === "admin" ? null : role)
})

/**
 * Thrown by getDocker() when the user has no environment to work with. It is
 * a DockerError, so runAction/tryDocker turn it into a message, and
 * DockerUnavailable renders NO_ENVIRONMENT_ASSIGNED as an empty state.
 */
export class NoEnvironmentError extends DockerError {
  constructor(message: string) {
    super(message, 403)
    this.name = "NoEnvironmentError"
  }
}

/** Thrown when an action was made for another environment than the selected one. */
export class EnvironmentSwitchedError extends DockerError {
  constructor() {
    super(ENVIRONMENT_SWITCHED, 409)
    this.name = "EnvironmentSwitchedError"
  }
}

/**
 * Docker client bound to the current environment. Callers must authenticate
 * first. Pass the id of the environment the page was rendered for so an
 * action never lands on another host after a switch in another tab.
 */
export async function getDocker(expectedId?: number) {
  const env = await getCurrentEnvironment()
  if (!env) {
    const user = await getCurrentUser()
    throw new NoEnvironmentError(user?.role === "admin" ? "No Docker environment configured" : NO_ENVIRONMENT_ASSIGNED)
  }
  if (expectedId !== undefined && env.id !== expectedId) throw new EnvironmentSwitchedError()
  return docker(environmentTarget(env), { credentials: credentialsForImage })
}
