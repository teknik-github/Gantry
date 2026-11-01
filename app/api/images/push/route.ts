import type { NextRequest } from "next/server"

import { parseImageReference } from "@/lib/image-build"
import { expectedEnvironment } from "@/lib/server/action"
import { authorizeRequest } from "@/lib/server/api-auth"
import { json } from "@/lib/server/http"
import { dockerTargetFor, startPush } from "@/lib/server/images/run"

/**
 * Pushes one tag of the current environment to its registry with the login
 * stored for that registry (Registries). JSON body: { reference,
 * environmentId? }. Streams progress like /api/images/build; closing the
 * request cancels the push. Needs the manager role.
 */
export async function POST(request: NextRequest) {
  const auth = await authorizeRequest("manage")
  if (auth.response) return auth.response

  const body = (await request.json().catch(() => null)) as { reference?: unknown; environmentId?: unknown } | null
  const parsed = parseImageReference(typeof body?.reference === "string" ? body.reference : "")
  if (!parsed.ok) return json(400, { error: parsed.error })

  const target = dockerTargetFor(auth.environment, expectedEnvironment(body?.environmentId))
  if (target instanceof Response) return target

  return startPush({ user: auth.user, target, reference: parsed.value.reference, requestSignal: request.signal })
}
