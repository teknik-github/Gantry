import type { NextRequest } from "next/server"

import { getCurrentUser } from "@/lib/server/auth/dal"
import { getOperation, type HelmOperationEvent } from "@/lib/server/kubernetes/helm-operations"

/**
 * Output of a Helm install/upgrade/rollback started by the signed-in user,
 * as newline-delimited JSON: {"type":"output","text":…} events (what was
 * printed so far, then live) and a final {"type":"done","ok":…,"message":…}.
 * Only the user who started the operation can follow it; the output is
 * already redacted.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/kubernetes/helm/operations/[id]">) {
  const user = await getCurrentUser()
  if (!user || user.via !== "session") return Response.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await ctx.params
  const op = /^[A-Za-z0-9_-]{8,64}$/.test(id) ? getOperation(id, user.id) : null
  if (!op) return Response.json({ error: "Operation not found (it may have finished a while ago)" }, { status: 404 })

  const encoder = new TextEncoder()
  let stop = () => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true
      const close = () => {
        if (!open) return
        open = false
        stop()
        try {
          controller.close()
        } catch {
          // Already closed: the client went away.
        }
      }
      const send = (event: HelmOperationEvent) => {
        if (!open) return
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        // Close after the listener registration has returned.
        if (event.type === "done") queueMicrotask(close)
      }
      stop = op.follow(send)
      request.signal.addEventListener("abort", close, { once: true })
    },
    cancel() {
      stop()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
