import { NextResponse, type NextRequest } from "next/server"

import { getCurrentUser } from "@/lib/server/auth/dal"
import { completeOidc } from "@/lib/server/auth/oidc-flow"

/** The identity provider's redirect after sign-in (registered as the OIDC redirect URI). */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  const outcome = await completeOidc(request.nextUrl.searchParams, user?.via === "session" ? user.id : null)
  const to = (path: string) => NextResponse.redirect(new URL(path, request.url))
  switch (outcome.kind) {
    case "signed-in":
      return to(outcome.next)
    case "linked":
      return to("/account?sso=linked")
    default:
      return to(outcome.link ? `/account?sso=${outcome.reason}` : `/login?sso=${outcome.reason}`)
  }
}
