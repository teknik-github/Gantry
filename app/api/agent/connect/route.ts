import type { NextRequest } from "next/server"

import { acceptAgent } from "@/lib/server/agent/hub"
import { config } from "@/lib/server/config"
import { getDb } from "@/lib/server/db"
import { clientAddress } from "@/lib/server/login-limits"

/**
 * An agent's downstream: authenticated with its enrollment key
 * ("Authorization: Bearer gak_…"), answered with a long-lived stream of
 * frames (lib/agent/protocol.ts) that lasts as long as the session.
 *
 * /api/agent/* bypasses proxy.ts (see its matcher): agents have no session
 * cookie, and the proxy would buffer upstream bodies. These handlers
 * authenticate every request themselves.
 */
export async function GET(request: NextRequest) {
  const headers = request.headers
  // Next.js fills X-Forwarded-For with the peer address when absent; only
  // shown to admins. The rate limit uses it only when TRUST_PROXY says so.
  const remoteAddress = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || null
  const res = await acceptAgent(await getDb(), {
    authorization: headers.get("authorization"),
    info: headers.get("x-gantry-agent-info"),
    clientAddress: clientAddress(headers, config.trustProxy),
    remoteAddress: remoteAddress?.slice(0, 64) ?? null,
  })
  if (!res.ok) {
    return Response.json(
      { error: res.error },
      {
        status: res.status,
        headers: { "Cache-Control": "no-store", ...(res.retryAfter ? { "Retry-After": String(res.retryAfter) } : {}) },
      }
    )
  }
  const { session } = res
  request.signal.addEventListener("abort", () => session.close("the agent disconnected", { notify: false }), { once: true })
  return new Response(session.downstream, {
    headers: {
      "Content-Type": "application/octet-stream",
      // no-transform keeps compressing proxies from buffering the stream.
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
