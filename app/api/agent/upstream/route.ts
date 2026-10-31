import type { NextRequest } from "next/server"

import { receiveUpstream } from "@/lib/server/agent/hub"

/**
 * An agent's upstream: one numbered batch of frames per POST, authenticated
 * with the session id and secret it got in its HELLO frame. Outside proxy.ts
 * (see the note in ../connect/route.ts), so the body is read as it arrives.
 */
export async function POST(request: NextRequest) {
  const res = await receiveUpstream({
    session: request.headers.get("x-gantry-agent-session"),
    authorization: request.headers.get("authorization"),
    seq: request.headers.get("x-gantry-agent-seq"),
    contentLength: request.headers.get("content-length"),
    body: request.body as AsyncIterable<Uint8Array> | null,
  })
  if (res.status === 204) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } })
  return Response.json({ error: res.error }, { status: res.status, headers: { "Cache-Control": "no-store" } })
}
