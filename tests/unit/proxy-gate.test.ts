import { NextRequest, type NextResponse } from "next/server"
import { getRedirectUrl, unstable_doesMiddlewareMatch } from "next/experimental/testing/server"
import { describe, expect, it } from "vitest"

import { config, proxy } from "@/proxy"
import { API_AUTH_HEADER, apiAuthMarker, SESSION_COOKIE, signSession } from "@/lib/server/auth/token"

// The gate in front of the whole app (proxy.ts): who gets through, what is
// refused, and which paths it runs on at all. Handlers re-check the user in
// the DAL; these tests only cover proxy's own part.

const ORIGIN = "http://gantry.test"
const TOKEN = `gtk_${"A".repeat(43)}`
const HOOK = "h".repeat(32)

async function session(role: "admin" | "user" = "user") {
  return signSession({ uid: 1, role, ver: 0 })
}

function request(
  path: string,
  opts: { method?: string; cookie?: string; headers?: Record<string, string> } = {}
): NextRequest {
  const headers = new Headers(opts.headers)
  if (opts.cookie !== undefined) headers.set("cookie", `${SESSION_COOKIE}=${opts.cookie}`)
  return new NextRequest(`${ORIGIN}${path}`, { method: opts.method ?? "GET", headers })
}

/** NextResponse.next() passes the request on; a redirect or an error answer does not. */
function passedOn(res: NextResponse) {
  return res.headers.get("x-middleware-next") === "1"
}

/** A request header as proxy forwards it to the app (null: removed or never set). */
function forwarded(res: NextResponse, name: string): string | null {
  const overridden = (res.headers.get("x-middleware-override-headers") ?? "").split(",")
  if (!overridden.includes(name)) return null
  return res.headers.get(`x-middleware-request-${name}`)
}

describe("proxy: API routes", () => {
  it("refuses /api/* without a session or token, with no-store", async () => {
    for (const path of ["/api/stats", "/api/v1/containers", "/api/files/list?path=/", "/api/exec/x"]) {
      const res = await proxy(request(path))
      expect(res.status, path).toBe(401)
      expect(await res.json()).toEqual({ error: "Unauthorized" })
      expect(res.headers.get("cache-control")).toBe("no-store")
    }
  })

  it("refuses a tampered or foreign session cookie", async () => {
    const good = await session()
    const tampered = `${good.slice(0, -2)}${good.endsWith("AA") ? "BB" : "AA"}`
    expect((await proxy(request("/api/stats", { cookie: tampered }))).status).toBe(401)
    expect((await proxy(request("/api/stats", { cookie: "not-a-jwt" }))).status).toBe(401)
  })

  it("lets a valid session through and marks responses no-store, no-transform", async () => {
    const res = await proxy(request("/api/stats", { cookie: await session() }))
    expect(passedOn(res)).toBe(true)
    expect(res.headers.get("cache-control")).toBe("no-store, no-transform")
  })

  it("lets a well-formed API token through and marks the request for the DAL", async () => {
    const res = await proxy(request("/api/v1/containers", { headers: { authorization: `Bearer ${TOKEN}` } }))
    expect(passedOn(res)).toBe(true)
    expect(forwarded(res, API_AUTH_HEADER)).toBe(apiAuthMarker())
  })

  it("refuses malformed tokens and tokens on Server Action requests", async () => {
    for (const authorization of [`Bearer ${TOKEN.slice(0, -1)}`, "Bearer not-a-token", `Basic ${TOKEN}`, TOKEN]) {
      expect((await proxy(request("/api/stats", { headers: { authorization } }))).status, authorization).toBe(401)
    }
    const action = request("/api/stats", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "next-action": "abc" } })
    expect((await proxy(action)).status).toBe(401)
  })

  it("never forwards a client-supplied API marker", async () => {
    const spoof = { [API_AUTH_HEADER]: apiAuthMarker() }
    // With a session: the header is removed, not passed on.
    const withSession = await proxy(request("/api/stats", { cookie: await session(), headers: spoof }))
    expect(passedOn(withSession)).toBe(true)
    expect(forwarded(withSession, API_AUTH_HEADER)).toBeNull()
    expect(withSession.headers.get("x-middleware-override-headers")).not.toContain(API_AUTH_HEADER)
    // Alone it authenticates nothing.
    expect((await proxy(request("/api/stats", { headers: spoof }))).status).toBe(401)
    // A token on a Server Action request is no token: the marker is not set.
    const action = await proxy(
      request("/api/stats", { method: "POST", cookie: await session(), headers: { ...spoof, authorization: `Bearer ${TOKEN}`, "next-action": "x" } })
    )
    expect(passedOn(action)).toBe(true)
    expect(forwarded(action, API_AUTH_HEADER)).toBeNull()
    // Pages never get it either, even with a token.
    const page = await proxy(request("/containers", { cookie: await session(), headers: { ...spoof, authorization: `Bearer ${TOKEN}` } }))
    expect(passedOn(page)).toBe(true)
    expect(forwarded(page, API_AUTH_HEADER)).toBeNull()
  })

  it("forwards the client's other headers unchanged", async () => {
    const res = await proxy(request("/api/stats", { cookie: await session(), headers: { "x-gantry-environment": "2", "accept-language": "id" } }))
    expect(forwarded(res, "x-gantry-environment")).toBe("2")
    expect(forwarded(res, "accept-language")).toBe("id")
  })

  it("refuses cross-site browser requests to the API, after authentication", async () => {
    const cookie = await session()
    for (const site of ["cross-site", "same-site"]) {
      const res = await proxy(request("/api/stats", { cookie, headers: { "sec-fetch-site": site } }))
      expect(res.status, site).toBe(403)
      expect(await res.json()).toEqual({ error: "Forbidden" })
    }
    // Same origin, the user's own navigation, and scripts (no header) are fine.
    for (const site of ["same-origin", "none", undefined]) {
      const res = await proxy(request("/api/stats", { cookie, headers: site ? { "sec-fetch-site": site } : {} }))
      expect(passedOn(res), String(site)).toBe(true)
    }
    // Token clients from another site are refused too.
    const token = await proxy(request("/api/stats", { headers: { authorization: `Bearer ${TOKEN}`, "sec-fetch-site": "cross-site" } }))
    expect(token.status).toBe(403)
    // Without credentials it is a 401 first.
    expect((await proxy(request("/api/stats", { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(401)
  })

  it("leaves the healthcheck public (but still strips the marker)", async () => {
    const res = await proxy(request("/api/health", { headers: { [API_AUTH_HEADER]: "x", "sec-fetch-site": "cross-site" } }))
    expect(passedOn(res)).toBe(true)
    expect(forwarded(res, API_AUTH_HEADER)).toBeNull()
    expect(passedOn(await proxy(request("/api/health/deep")))).toBe(true)
    // Only that path: a lookalike prefix is not public.
    expect((await proxy(request("/api/healthz"))).status).toBe(401)
  })
})

describe("proxy: Git stack webhooks", () => {
  const hook = (id: string, opts: { method?: string; length?: number; headers?: Record<string, string> } = {}) =>
    request(`/api/webhooks/stacks/${id}`, {
      method: opts.method ?? "POST",
      headers: { ...(opts.length !== undefined ? { "content-length": String(opts.length) } : {}), ...opts.headers },
    })

  it("lets deliveries through without a session (the handler checks the secret)", async () => {
    const res = await proxy(hook(HOOK, { length: 100, headers: { [API_AUTH_HEADER]: apiAuthMarker() } }))
    expect(passedOn(res)).toBe(true)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(forwarded(res, API_AUTH_HEADER)).toBeNull()
    // Git hosts are not browsers on our origin; no cross-site refusal here.
    expect(passedOn(await proxy(hook(HOOK, { headers: { "sec-fetch-site": "cross-site" } })))).toBe(true)
  })

  it("refuses bodies over 1 MB before they are read", async () => {
    expect(passedOn(await proxy(hook(HOOK, { length: 1024 * 1024 })))).toBe(true)
    const res = await proxy(hook(HOOK, { length: 1024 * 1024 + 1 }))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: "Payload too large" })
  })

  it("only exempts POSTs to a well-formed hook id", async () => {
    expect((await proxy(hook(HOOK, { method: "GET" }))).status).toBe(401)
    expect((await proxy(hook("short"))).status).toBe(401)
    expect((await proxy(hook(`${HOOK}/extra`))).status).toBe(401)
    expect((await proxy(hook(`${"h".repeat(31)}!`))).status).toBe(401)
    expect((await proxy(request(`/api/webhooks/other/${HOOK}`, { method: "POST" }))).status).toBe(401)
    // The size cap only applies to the exempted deliveries; others are refused for lack of a session.
    expect((await proxy(hook("short", { length: 10 * 1024 * 1024 }))).status).toBe(401)
  })
})

describe("proxy: pages", () => {
  it("sends signed-out visitors to /login, keeping where they were going", async () => {
    const res = await proxy(request("/containers/abc?tab=logs"))
    expect(res.status).toBe(307)
    const url = new URL(getRedirectUrl(res)!)
    expect(url.pathname).toBe("/login")
    expect(url.searchParams.get("next")).toBe("/containers/abc?tab=logs")
  })

  it("does not add ?next for the home page and the dashboard", async () => {
    for (const path of ["/", "/dashboard"]) {
      expect(getRedirectUrl(await proxy(request(path)))).toBe(`${ORIGIN}/login`)
    }
  })

  it("drops an invalid session cookie on the way to /login", async () => {
    const res = await proxy(request("/containers", { cookie: "expired-or-tampered" }))
    expect(new URL(getRedirectUrl(res)!).pathname).toBe("/login")
    const cleared = res.cookies.get(SESSION_COOKIE)
    expect(cleared?.value).toBe("")
    expect(cleared?.expires && new Date(cleared.expires).getTime()).toBeLessThanOrEqual(Date.now())
    // Without a cookie there is nothing to clear.
    expect((await proxy(request("/containers"))).cookies.get(SESSION_COOKIE)).toBeUndefined()
  })

  it("serves /login and /setup to signed-out visitors and sends signed-in users to the dashboard", async () => {
    for (const path of ["/login", "/setup", "/login/anything"]) {
      expect(passedOn(await proxy(request(path))), path).toBe(true)
      expect(getRedirectUrl(await proxy(request(path, { cookie: await session() }))), path).toBe(`${ORIGIN}/dashboard`)
    }
    // A lookalike is not public.
    expect(new URL(getRedirectUrl(await proxy(request("/loginx")))!).pathname).toBe("/login")
  })

  it("lets /auth/* through with or without a session", async () => {
    for (const path of ["/auth/signout", "/auth/oidc/callback?code=x"]) {
      expect(passedOn(await proxy(request(path))), path).toBe(true)
      expect(passedOn(await proxy(request(path, { cookie: await session() }))), path).toBe(true)
    }
  })

  it("lets signed-in users through to app pages", async () => {
    const res = await proxy(request("/containers", { cookie: await session("admin") }))
    expect(passedOn(res)).toBe(true)
  })
})

describe("proxy: matcher", () => {
  const runs = (url: string, method = "GET") => unstable_doesMiddlewareMatch({ config, url, headers: { ":method": method } })

  it("runs on pages and the API", () => {
    for (const url of [
      "/",
      "/login",
      "/dashboard",
      "/containers/abc",
      "/api/stats",
      "/api/v1/containers",
      "/api/files/list?path=/",
      "/api/files/download",
      "/api/images/build",
      "/api/images/push",
      "/api/images/builds/1",
      "/api/exec/abc",
      "/api/webhooks/stacks/" + HOOK,
      "/api/health",
      // Lookalikes of excluded paths are still covered.
      "/api/images/build/uploads",
      "/api/images/build/upload/x",
      "/api/uploadsx",
      "/api/agentx",
      "/api/agent",
      "/_nextx/static",
      "/files/logo.svgx",
    ]) {
      expect(runs(url), url).toBe(true)
    }
  })

  it("skips Next internals, static files and the streamed or agent routes", () => {
    for (const url of [
      "/_next/static/chunks/main.js",
      "/_next/image?url=/x.png&w=64&q=75",
      "/favicon.ico",
      "/logo.svg",
      "/images/hero.png",
      "/a/b/c.jpg",
      "/x.jpeg",
      "/x.gif",
      "/x.webp",
      "/icon.ico",
      "/robots.txt",
      "/api/uploads/files",
      "/api/uploads/files?path=/tmp&name=a",
      "/api/images/build/upload",
      "/api/agent/connect",
      "/api/agent/upstream",
    ]) {
      expect(runs(url), url).toBe(false)
    }
  })
})
