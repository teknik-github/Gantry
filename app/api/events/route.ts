import type { NextRequest } from "next/server"

import { authorizeRequest } from "@/lib/server/api-auth"
import type { HubListener } from "@/lib/server/event-hub"
import { subscribeToEnvironment, subscribeToKubernetes } from "@/lib/server/live-events"

const HEARTBEAT_MS = 25_000
// Streams are re-opened periodically so a session that expired or a user
// that was deleted doesn't keep receiving events (re-checked on reconnect).
const MAX_STREAM_MS = 10 * 60_000

/**
 * Live events of the current environment as Server-Sent Events:
 *   event: status      data: {"status":"connecting"|"connected"|"reconnecting"}
 *   event: docker      data: DockerLiveEvent (see lib/live.ts)
 *   event: kubernetes  data: KubeLiveEvent, from the cluster's watches
 *   event: rotate  the server is about to close this stream; open a new one
 * plus a ": ping" comment every 25s. All tabs share one Docker connection
 * (or one set of Kubernetes watches) per environment (lib/server/live-events.ts). `?probe=1` only checks the
 * session, for clients whose EventSource failed and need to know why.
 */
export async function GET(request: NextRequest) {
  const auth = await authorizeRequest("view")
  if (auth.response) {
    // The probe only asks whether the session is still valid.
    if (auth.response.status !== 401 && request.nextUrl.searchParams.has("probe")) return new Response(null, { status: 204 })
    return auth.response
  }
  if (request.nextUrl.searchParams.has("probe")) return new Response(null, { status: 204 })

  const env = auth.environment
  if (!env) return Response.json({ error: "No Docker environment configured" }, { status: 404 })
  // The whole row: the event stream needs its TLS material (or kube credentials).
  const subscribe = (listener: HubListener) =>
    env.type === "kubernetes" ? subscribeToKubernetes(env, listener) : subscribeToEnvironment({ ...env, type: env.type }, listener)

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
      let unsubscribe = () => {}
      try {
        unsubscribe = subscribe((msg) => {
          if (msg.kind === "status") send(`event: status\ndata: ${JSON.stringify({ status: msg.status })}\n\n`)
          else send(`event: ${msg.event.type === "kubernetes" ? "kubernetes" : "docker"}\ndata: ${JSON.stringify(msg.event)}\n\n`)
        })
      } catch (err) {
        // Undecryptable credentials: report it as an interrupted stream.
        console.warn(`[gantry] live events for environment ${env.id}: ${(err as Error).message}`)
        send(`event: status\ndata: ${JSON.stringify({ status: "reconnecting" })}\n\n`)
      }
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
