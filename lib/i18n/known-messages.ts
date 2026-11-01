// Fixed English messages produced by library code (lib/messages.ts and a few
// server helpers that also run outside a request, e.g. in unit tests). They
// stay English at the source and are translated where they are shown.

import type { I18n } from "@/lib/i18n"
import { DOCKER_ENVIRONMENT, ENVIRONMENT_SWITCHED, KUBERNETES_ENVIRONMENT, NO_ENVIRONMENT_ASSIGNED } from "@/lib/messages"

const KNOWN: Record<string, (t: I18n["t"]) => string> = {
  [NO_ENVIRONMENT_ASSIGNED]: (t) => t.common.environment.noneAssigned,
  [KUBERNETES_ENVIRONMENT]: (t) => t.common.environment.isKubernetes,
  [DOCKER_ENVIRONMENT]: (t) => t.common.environment.isDocker,
  [ENVIRONMENT_SWITCHED]: (t) => t.common.environment.switched,
  "No Docker environment configured": (t) => t.common.environment.noDockerConfigured,
  "No environment configured": (t) => t.common.environment.noneConfigured,
  "Something went wrong. Check the server logs.": (t) => t.common.errors.somethingWentWrong,
  "Your session has expired. Please sign in again.": (t) => t.common.errors.sessionExpired,
  "Only administrators can do this.": (t) => t.common.errors.adminsOnly,
  "Nothing selected": (t) => t.common.errors.nothingSelected,
  "Please fix the highlighted fields": (t) => t.common.errors.fixFields,
  Unauthorized: (t) => t.common.errors.sessionExpired,
}

/** The message in the current language if it is one of the fixed ones above, else unchanged. */
export function translateKnown(i18n: I18n, message: string): string {
  const known = KNOWN[message]
  return known ? known(i18n.t) : message
}
