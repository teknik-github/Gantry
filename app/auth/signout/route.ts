import { cookies } from "next/headers"
import { NextResponse, type NextRequest } from "next/server"

import { getCurrentUser } from "@/lib/server/auth/dal"
import { SESSION_COOKIE } from "@/lib/server/auth/token"

/**
 * Clears a session cookie that is still validly signed but no longer
 * accepted (user deleted, signed out everywhere, password or role changed),
 * then shows the login page. requireUser() sends such requests here; a valid
 * session is left alone, so this can't be used to sign someone out.
 */
export async function GET(request: NextRequest) {
  if (await getCurrentUser()) return NextResponse.redirect(new URL("/dashboard", request.url))
  ;(await cookies()).delete(SESSION_COOKIE)
  return NextResponse.redirect(new URL("/login", request.url))
}
