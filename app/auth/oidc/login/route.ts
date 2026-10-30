import { NextResponse, type NextRequest } from "next/server"

import { getCurrentUser } from "@/lib/server/auth/dal"
import { beginOidc } from "@/lib/server/auth/oidc-flow"

/** "Sign in with SSO": redirects to the identity provider (GET /auth/oidc/login?next=/path). */
export async function GET(request: NextRequest) {
  if (await getCurrentUser()) return NextResponse.redirect(new URL("/dashboard", request.url))
  try {
    const url = await beginOidc({ next: request.nextUrl.searchParams.get("next") })
    return NextResponse.redirect(url)
  } catch (err) {
    console.error(`[gantry] single sign-on unavailable: ${(err as Error).message}`)
    return NextResponse.redirect(new URL("/login?sso=unavailable", request.url))
  }
}
