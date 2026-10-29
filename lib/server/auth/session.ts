import "server-only"

import { cookies, headers } from "next/headers"

import { config } from "@/lib/server/config"
import { SESSION_COOKIE, signSession, type SessionPayload } from "@/lib/server/auth/token"

async function shouldUseSecureCookie() {
  if (config.cookieSecure === "true") return true
  if (config.cookieSecure === "false") return false
  const h = await headers()
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim()
  if (proto) return proto === "https"
  const origin = h.get("origin")
  return origin ? origin.startsWith("https://") : false
}

export async function createSession(payload: SessionPayload) {
  const token = await signSession(payload)
  ;(await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: await shouldUseSecureCookie(),
    maxAge: config.sessionTtlHours * 60 * 60,
  })
}

export async function destroySession() {
  ;(await cookies()).delete(SESSION_COOKIE)
}
