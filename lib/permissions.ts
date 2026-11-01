// Who may do what, shared by the server (enforcement) and the UI (hiding
// controls). Kept free of server imports so client components can use it.
//
// Global roles: "admin" manages Gantry itself (users, environments,
// registries, notifications...) and has every right in every environment.
// Standard users ("user") get a role per environment they were granted:
//
//   viewer   read-only: lists, details, dashboard and resource usage
//   operator viewer + start/stop/restart/pause/kill, logs, update checks
//   manager  operator + everything an administrator can do inside that
//            environment: create/remove, stacks, template deploys, console,
//            container edits, proxy, per-container auto-update...

export const ENVIRONMENT_ROLES = ["viewer", "operator", "manager"] as const
export type EnvironmentRole = (typeof ENVIRONMENT_ROLES)[number]

/** What an action needs inside the current environment. */
export type EnvironmentPermission = "view" | "operate" | "manage"

export const ROLE_LABELS: Record<EnvironmentRole, string> = {
  viewer: "Viewer",
  operator: "Operator",
  manager: "Manager",
}

const RANK: Record<EnvironmentRole, number> = { viewer: 1, operator: 2, manager: 3 }
const NEEDED: Record<EnvironmentPermission, EnvironmentRole> = { view: "viewer", operate: "operator", manage: "manager" }

export function isEnvironmentRole(value: unknown): value is EnvironmentRole {
  return typeof value === "string" && (ENVIRONMENT_ROLES as readonly string[]).includes(value)
}

/** The least role that grants `permission`. */
export function roleFor(permission: EnvironmentPermission): EnvironmentRole {
  return NEEDED[permission]
}

/**
 * Whether a user may do `permission` in an environment. `globalRole` is the
 * user's role, `environmentRole` their grant for that environment (null =
 * no access). Administrators may do everything everywhere.
 */
export function allows(
  globalRole: "admin" | "user",
  environmentRole: EnvironmentRole | null,
  permission: EnvironmentPermission
): boolean {
  if (globalRole === "admin") return true
  if (!environmentRole) return false
  return RANK[environmentRole] >= RANK[NEEDED[permission]]
}

/** Flags for the UI: what the signed-in user may do in the current environment. */
export type Permissions = {
  view: boolean
  operate: boolean
  manage: boolean
  /** Global administrator. */
  admin: boolean
}

export function permissionsFor(globalRole: "admin" | "user", environmentRole: EnvironmentRole | null): Permissions {
  return {
    view: allows(globalRole, environmentRole, "view"),
    operate: allows(globalRole, environmentRole, "operate"),
    manage: allows(globalRole, environmentRole, "manage"),
    admin: globalRole === "admin",
  }
}

export const NO_PERMISSIONS: Permissions = { view: false, operate: false, manage: false, admin: false }

/**
 * Form field carrying the id of the environment a page was rendered for
 * (added to every FormDialog by components/gantry/environment-scope.tsx).
 */
export const ENVIRONMENT_FIELD = "_env"
