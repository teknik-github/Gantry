import type { NextRequest } from "next/server"

import { authorizeRequest } from "@/lib/server/api-auth"
import { getDocker } from "@/lib/server/environments"
import { errorResponse, searchParamsObject } from "@/lib/server/files/http"
import { listFiles, parsePath, parseTarget } from "@/lib/server/files/service"

// Folder listing of a container or volume. Files may hold secrets, so
// browsing needs the operator role (like logs); viewers only see lists.
export async function GET(request: NextRequest) {
  const auth = await authorizeRequest("operate")
  if (auth.response) return auth.response
  try {
    const params = request.nextUrl.searchParams
    const target = parseTarget(searchParamsObject(params))
    const path = parsePath(params.get("path") ?? "/")
    const listing = await listFiles(await getDocker(), target, path, request.signal)
    return Response.json(listing, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    return errorResponse(err)
  }
}
