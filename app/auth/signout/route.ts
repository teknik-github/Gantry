import { cookies } from "next/headers"

import { getCurrentUser } from "@/lib/server/auth/dal"
import { SESSION_COOKIE } from "@/lib/server/auth/token"
import { redirectTo } from "@/lib/server/redirect"

/**
 * Clears a session cookie that is still validly signed but no longer
 * accepted (user deleted, signed out everywhere, password or role changed),
 * then shows the login page. requireUser() sends such requests here; a valid
 * session is left alone, so this can't be used to sign someone out.
 */
export async function GET() {
  if (await getCurrentUser()) return redirectTo("/dashboard")
  ;(await cookies()).delete(SESSION_COOKIE)
  return redirectTo("/login")
}
