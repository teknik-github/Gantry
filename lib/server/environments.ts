import "server-only"

import { cache } from "react"
import { cookies } from "next/headers"

import { NO_ENVIRONMENT_ASSIGNED } from "@/lib/messages"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { ENV_COOKIE } from "@/lib/server/auth/token"
import { getDb } from "@/lib/server/db"
import type { Environment } from "@/lib/server/db/schema"
import { docker } from "@/lib/server/docker/api"
import { DockerError } from "@/lib/server/docker/client"
import { environmentsForUser } from "@/lib/server/environment-access"
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

/** The environment selected via the env cookie, falling back to the first allowed one. */
export const getCurrentEnvironment = cache(async (): Promise<Environment | null> => {
  const envs = await listEnvironments()
  const selected = Number((await cookies()).get(ENV_COOKIE)?.value)
  return envs.find((e) => e.id === selected) ?? envs[0] ?? null
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

/** Docker client bound to the current environment. Callers must authenticate first. */
export async function getDocker() {
  const env = await getCurrentEnvironment()
  if (!env) {
    const user = await getCurrentUser()
    throw new NoEnvironmentError(user?.role === "admin" ? "No Docker environment configured" : NO_ENVIRONMENT_ASSIGNED)
  }
  return docker(environmentTarget(env))
}
