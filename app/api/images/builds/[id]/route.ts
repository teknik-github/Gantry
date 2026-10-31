import type { NextRequest } from "next/server"

import { authorizeRequest } from "@/lib/server/api-auth"
import { getBuild } from "@/lib/server/images/builds"

/** One build of the current environment with its log (managers, like the build page). */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/images/builds/[id]">) {
  const auth = await authorizeRequest("manage")
  if (auth.response) return auth.response
  const { id } = await ctx.params
  if (!/^\d{1,12}$/.test(id) || !auth.environment) return Response.json({ error: "Not found" }, { status: 404 })
  const build = await getBuild(auth.environment.id, Number(id))
  if (!build) return Response.json({ error: "Not found" }, { status: 404 })
  return Response.json(build, { headers: { "Cache-Control": "no-store" } })
}
