import "server-only"

import { NO_ENVIRONMENT_ASSIGNED } from "@/lib/messages"
import { allows, ROLE_LABELS, roleFor, type EnvironmentPermission } from "@/lib/permissions"
import { getCurrentUser, type CurrentUser } from "@/lib/server/auth/dal"
import type { Environment } from "@/lib/server/db/schema"
import { getCurrentEnvironment, getEnvironmentRole } from "@/lib/server/environments"
import { json } from "@/lib/server/http"

type Options = {
  /** Refuse API tokens (interactive, browser-only endpoints such as the console). */
  sessionOnly?: boolean
}

/**
 * Route handler guard: the user from the cookie session or an API token
 * (proxy.ts marks token requests) with `permission` in the current
 * environment. Returns the response to send otherwise: 401 without a user,
 * 403 without the role, 404 when there is no environment to use.
 */
export async function authorizeRequest(
  permission: EnvironmentPermission,
  options: Options = {}
): Promise<{ user: CurrentUser; environment: Environment | null; response?: never } | { response: Response }> {
  const user = await getCurrentUser()
  if (!user) return { response: json(401, { error: "Unauthorized" }) }
  if (options.sessionOnly && user.via !== "session") return { response: json(403, { error: "Not available with API tokens" }) }
  const environment = await getCurrentEnvironment()
  if (user.role === "admin") return { user, environment }
  if (!environment) return { response: json(403, { error: NO_ENVIRONMENT_ASSIGNED }) }
  const role = await getEnvironmentRole()
  if (!allows(user.role, role === "admin" ? null : role, permission)) {
    return { response: json(403, { error: `This needs the ${ROLE_LABELS[roleFor(permission)].toLowerCase()} role in ${environment.name}` }) }
  }
  return { user, environment }
}
