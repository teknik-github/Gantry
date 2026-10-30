import { NextResponse, type NextRequest } from "next/server"

import { getCurrentUser } from "@/lib/server/auth/dal"
import { beginOidc } from "@/lib/server/auth/oidc-flow"
import { redirectTo } from "@/lib/server/redirect"

/** "Sign in with SSO": redirects to the identity provider (GET /auth/oidc/login?next=/path). */
export async function GET(request: NextRequest) {
  if (await getCurrentUser()) return redirectTo("/dashboard")
  try {
    return NextResponse.redirect(await beginOidc({ next: request.nextUrl.searchParams.get("next") }))
  } catch (err) {
    console.error(`[gantry] single sign-on unavailable: ${(err as Error).message}`)
    return redirectTo("/login?sso=unavailable")
  }
}
