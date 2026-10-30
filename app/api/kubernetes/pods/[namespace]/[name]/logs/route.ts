import type { NextRequest } from "next/server"

import { DNS_LABEL_RE, namespaceSchema, objectNameSchema } from "@/lib/kubernetes/names"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { getKube, KubeError } from "@/lib/server/kubernetes"

/**
 * Recent log lines of a pod's container in the current Kubernetes
 * environment: GET ?container=<name>&tail=<lines>&environment=<id>. Viewing
 * logs needs only access to the environment, like Docker container logs.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/kubernetes/pods/[namespace]/[name]/logs">) {
  if (!(await getCurrentUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { namespace, name } = await ctx.params
  const params = request.nextUrl.searchParams
  const container = params.get("container") || undefined
  if (!namespaceSchema.safeParse(namespace).success || !objectNameSchema.safeParse(name).success) {
    return Response.json({ error: "Invalid pod" }, { status: 400 })
  }
  if (container && (container.length > 63 || !DNS_LABEL_RE.test(container))) {
    return Response.json({ error: "Invalid container" }, { status: 400 })
  }
  const tail = Math.min(5000, Math.max(10, Number(params.get("tail")) || 500))
  const environment = Number(params.get("environment")) || undefined

  try {
    const { api } = await getKube(environment)
    const logs = await api.podLogs(namespace, name, { container, tailLines: tail })
    return new Response(logs, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    })
  } catch (err) {
    // The cluster rejecting Gantry's token is not the browser's session expiring: no 401.
    const status = err instanceof KubeError ? (err.status > 401 && err.status < 600 ? err.status : 502) : 500
    if (!(err instanceof KubeError)) console.error("[gantry] pod logs failed", err)
    return Response.json({ error: err instanceof KubeError ? err.message : "Could not load the logs" }, { status })
  }
}
