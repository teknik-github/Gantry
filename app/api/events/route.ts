import type { NextRequest } from "next/server"

import { getCurrentUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { subscribeToEnvironment } from "@/lib/server/live-events"

const HEARTBEAT_MS = 25_000
// Streams are re-opened periodically so a session that expired or a user
// that was deleted doesn't keep receiving events (re-checked on reconnect).
const MAX_STREAM_MS = 10 * 60_000

/**
 * Live Docker events of the current environment as Server-Sent Events:
 *   event: status  data: {"status":"connecting"|"connected"|"reconnecting"}
 *   event: docker  data: LiveEvent (see lib/live.ts)
 *   event: rotate  the server is about to close this stream; open a new one
 * plus a ": ping" comment every 25s. All tabs share one Docker connection per
 * environment (lib/server/live-events.ts). `?probe=1` only checks the
 * session, for clients whose EventSource failed and need to know why.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 })
  if (request.nextUrl.searchParams.has("probe")) return new Response(null, { status: 204 })

  const env = await getCurrentEnvironment()
  if (!env) return Response.json({ error: "No Docker environment configured" }, { status: 404 })
  // Live updates follow Docker events; Kubernetes environments have none.
  if (env.type === "kubernetes") {
    return Response.json({ error: "Live updates are only available for Docker environments" }, { status: 404 })
  }
  const dockerEnv = { id: env.id, type: env.type, url: env.url }

  const encoder = new TextEncoder()
  let stop = () => {}

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const send = (text: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          stop()
        }
      }

      // Reconnect delay for EventSource, then the initial state.
      send(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ environment: env.id })}\n\n`)
      const unsubscribe = subscribeToEnvironment(dockerEnv, (msg) => {
        if (msg.kind === "status") send(`event: status\ndata: ${JSON.stringify({ status: msg.status })}\n\n`)
        else send(`event: docker\ndata: ${JSON.stringify(msg.event)}\n\n`)
      })
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS)
      const rotate = setTimeout(() => {
        send("event: rotate\ndata: {}\n\n")
        stop()
      }, MAX_STREAM_MS)

      stop = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        clearTimeout(rotate)
        unsubscribe()
        try {
          controller.close()
        } catch {
          // Already closed by the client.
        }
      }
      if (request.signal.aborted) stop()
      else request.signal.addEventListener("abort", () => stop(), { once: true })
    },
    cancel() {
      stop()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform keeps compression from buffering the stream.
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
