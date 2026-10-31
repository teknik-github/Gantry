import type { NextRequest } from "next/server"

import { authorizeRequest } from "@/lib/server/api-auth"
import { getDocker } from "@/lib/server/environments"
import { filesLimits } from "@/lib/server/files/config"
import { errorResponse, searchParamsObject } from "@/lib/server/files/http"
import { parsePath, parseTarget, readTextFile } from "@/lib/server/files/service"

// A small text file for the viewer/editor (operators view; saving needs a
// manager, see app/api/uploads/files).
export async function GET(request: NextRequest) {
  const auth = await authorizeRequest("operate")
  if (auth.response) return auth.response
  try {
    const params = request.nextUrl.searchParams
    const target = parseTarget(searchParamsObject(params))
    const path = parsePath(params.get("path"))
    const file = await readTextFile(await getDocker(), target, path)
    return Response.json({ ...file, limit: filesLimits().editMaxBytes }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    return errorResponse(err)
  }
}
