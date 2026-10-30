import type { NextRequest } from "next/server"

import { DNS_LABEL_RE, namespaceSchema, objectNameSchema } from "@/lib/kubernetes/names"
import { authorizeRequest } from "@/lib/server/api-auth"
import { getKube, KubeError } from "@/lib/server/kubernetes"

/** Followed log streams open on this server; each holds one API connection. */
const MAX_FOLLOWERS = 64
const globalForLogs = globalThis as unknown as { __gantryLogFollowers?: { count: number } }
const followers = (globalForLogs.__gantryLogFollowers ??= { count: 0 })

const DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024

function failure(err: unknown) {
  if (!(err instanceof KubeError)) console.error("[gantry] pod logs failed", err)
  // The cluster rejecting Gantry's token is not the browser's session expiring: no 401.
  const status = err instanceof KubeError ? (err.status > 401 && err.status < 600 ? err.status : 502) : 500
  return Response.json({ error: err instanceof KubeError ? err.message : "Could not load the logs" }, { status })
}

/**
 * Logs of a pod's container in the current Kubernetes environment.
 *
 *   ?container=<name>&tail=<lines>&environment=<id>
 *   &previous=1   the previous (restarted) instance of the container
 *   &follow=1     keep streaming new lines until the client disconnects
 *   &download=1   the whole log (up to 20 MB) as an attachment
 *
 * Like Docker container logs, this needs the operator role or more.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/kubernetes/pods/[namespace]/[name]/logs">) {
  const auth = await authorizeRequest("operate")
  if (auth.response) return auth.response

  const { namespace, name } = await ctx.params
  const params = request.nextUrl.searchParams
  const container = params.get("container") || undefined
  if (!namespaceSchema.safeParse(namespace).success || !objectNameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid pod" }, { status: 400 })
  }
  if (container && (container.length > 63 || !DNS_LABEL_RE.test(container))) {
    return Response.json({ error: "Invalid container" }, { status: 400 })
  }
  const download = params.get("download") === "1"
  const follow = !download && params.get("follow") === "1"
  const previous = params.get("previous") === "1"
  const tailLines = download ? undefined : Math.min(5000, Math.max(10, Number(params.get("tail")) || 500))
  const environment = Number(params.get("environment")) || undefined
  const opts = { container, tailLines, previous }

  let api
  try {
    api = (await getKube(environment)).api
  } catch (err) {
    return failure(err)
  }

  if (!follow) {
    try {
      const logs = await api.podLogs(namespace, name, { ...opts, limitBytes: download ? DOWNLOAD_LIMIT_BYTES : undefined })
      const file = `${name}${container ? `-${container}` : ""}${previous ? "-previous" : ""}.log`
      return new Response(logs, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          ...(download ? { "Content-Disposition": `attachment; filename="${file}"` } : {}),
        },
      })
    } catch (err) {
      return failure(err)
    }
  }

  if (followers.count >= MAX_FOLLOWERS) {
    return Response.json({ error: "Too many log streams are open. Close some tabs and try again." }, { status: 429 })
  }

  // The upstream request ends with the browser's: closing the tab or turning
  // follow off aborts it.
  const upstream = new AbortController()
  request.signal.addEventListener("abort", () => upstream.abort(), { once: true })
  let res: Awaited<ReturnType<typeof api.followPodLogs>>
  try {
    res = await api.followPodLogs(namespace, name, opts, upstream.signal)
  } catch (err) {
    return failure(err)
  }

  followers.count++
  let released = false
  const release = () => {
    if (released) return
    released = true
    followers.count--
    upstream.abort()
    res.destroy()
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true
      const close = () => {
        if (!open) return
        open = false
        release()
        try {
          controller.close()
        } catch {}
      }
      res.on("data", (chunk: Buffer) => {
        if (open) controller.enqueue(new Uint8Array(chunk))
      })
      res.on("end", close)
      res.on("close", close)
      res.on("error", close)
      upstream.signal.addEventListener("abort", close, { once: true })
    },
    cancel() {
      release()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // no-transform keeps compression from buffering the stream.
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
