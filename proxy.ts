import { NextResponse, type NextRequest } from "next/server"

import { WEBHOOK_ID_RE } from "@/lib/git-stacks"
import { SESSION_COOKIE, verifySession } from "@/lib/server/auth/token"

// Pages reachable without a session.
const PUBLIC_PAGES = ["/login", "/setup"]
// API routes reachable without a session (container healthcheck only).
const PUBLIC_API = ["/api/health"]
// Git stack webhooks: POST to exactly /api/webhooks/stacks/<opaque id>. The
// handler authenticates each delivery with the stack's secret.
const WEBHOOK_PREFIX = "/api/webhooks/stacks/"
const MAX_WEBHOOK_BODY = 1024 * 1024

function isWebhookDelivery(request: NextRequest, pathname: string) {
  return (
    request.method === "POST" &&
    pathname.startsWith(WEBHOOK_PREFIX) &&
    WEBHOOK_ID_RE.test(pathname.slice(WEBHOOK_PREFIX.length))
  )
}

function matches(pathname: string, list: string[]) {
  return list.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * Gate in front of the whole app. Every /api/* route requires a valid,
 * signed session (except the healthcheck and Git webhook deliveries, which
 * carry their own secret), so nothing else behind it is reachable anonymously. Pages are
 * redirected to /login. Handlers and Server Actions still re-check the user
 * through the DAL (proxy only checks the token, not the database).
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const token = request.cookies.get(SESSION_COOKIE)?.value
  const session = await verifySession(token)

  if (pathname.startsWith("/api/")) {
    if (matches(pathname, PUBLIC_API)) return NextResponse.next()
    if (isWebhookDelivery(request, pathname)) {
      // Refuse oversized bodies before they are buffered.
      if (Number(request.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BODY) {
        return NextResponse.json({ error: "Payload too large" }, { status: 413 })
      }
      const res = NextResponse.next()
      res.headers.set("Cache-Control", "no-store")
      return res
    }
    if (!session) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      )
    }
    // Only same-origin browser requests may use the API.
    const site = request.headers.get("sec-fetch-site")
    if (site && site !== "same-origin" && site !== "none") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
    const res = NextResponse.next()
    // no-transform: streamed routes (/api/events, /api/exec) must not be
    // buffered by compressing proxies; this header replaces the handler's.
    res.headers.set("Cache-Control", "no-store, no-transform")
    return res
  }

  const isPublic = matches(pathname, PUBLIC_PAGES)

  if (!session && !isPublic) {
    const url = new URL("/login", request.url)
    if (pathname !== "/" && pathname !== "/dashboard") {
      url.searchParams.set("next", pathname + search)
    }
    const res = NextResponse.redirect(url)
    // Drop an expired or tampered cookie.
    if (token) res.cookies.delete(SESSION_COOKIE)
    return res
  }

  if (session && isPublic) {
    return NextResponse.redirect(new URL("/dashboard", request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Everything except Next.js internals and static files in /public.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt)$).*)",
  ],
}
