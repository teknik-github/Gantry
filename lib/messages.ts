// User-facing messages shared by server code and client components.

/** Shown to a standard user who has not been granted any environment. */
export const NO_ENVIRONMENT_ASSIGNED = "No environment assigned — ask an administrator"

/** Docker pages opened while a Kubernetes environment is selected. */
export const KUBERNETES_ENVIRONMENT = "This is a Kubernetes environment"

/** Kubernetes pages opened while a Docker environment is selected. */
export const DOCKER_ENVIRONMENT = "This is a Docker environment"

/** A form or button of a page rendered for another environment than the selected one. */
export const ENVIRONMENT_SWITCHED = "The environment was switched in the meantime (maybe in another tab). Reload the page and try again."
