import type { NextRequest } from "next/server"

import { getCurrentUser } from "@/lib/server/auth/dal"
import { completeOidc } from "@/lib/server/auth/oidc-flow"
import { redirectTo } from "@/lib/server/redirect"

/** The identity provider's redirect after sign-in (registered as the OIDC redirect URI). */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  const outcome = await completeOidc(request.nextUrl.searchParams, user?.via === "session" ? user.id : null)
  switch (outcome.kind) {
    case "signed-in":
      return redirectTo(outcome.next)
    case "linked":
      return redirectTo("/account?sso=linked")
    default:
      return redirectTo(outcome.link ? `/account?sso=${outcome.reason}` : `/login?sso=${outcome.reason}`)
  }
}
