import type { NextRequest } from "next/server"

import { getCurrentUser } from "@/lib/server/auth/dal"
import { DockerError } from "@/lib/server/docker/client"
import { getDocker } from "@/lib/server/environments"

export async function GET(request: NextRequest, ctx: RouteContext<"/api/containers/[id]/logs">) {
  if (!(await getCurrentUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await ctx.params
  if (!/^[a-f0-9]{12,64}$/.test(id)) {
    return Response.json({ error: "Invalid container id" }, { status: 400 })
  }
  const tail = Math.min(5000, Math.max(10, Number(request.nextUrl.searchParams.get("tail")) || 500))

  try {
    const logs = await (await getDocker()).containerLogs(id, tail)
    return new Response(logs, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    })
  } catch (err) {
    const status = err instanceof DockerError ? err.status : 500
    return Response.json({ error: (err as Error).message }, { status })
  }
}
