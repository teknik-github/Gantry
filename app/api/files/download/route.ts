import type { NextRequest } from "next/server"

import { authorizeRequest } from "@/lib/server/api-auth"
import { audit } from "@/lib/server/audit"
import { toWebStream } from "@/lib/server/docker/stream"
import { getDocker } from "@/lib/server/environments"
import { contentDisposition, errorResponse, searchParamsObject } from "@/lib/server/files/http"
import { describe, openDownload, parsePath, parseTarget } from "@/lib/server/files/service"

// Downloads a file (raw bytes) or a folder (tar), streamed from Docker's
// archive API. Operators and up; every download is audited.
export async function GET(request: NextRequest) {
  const auth = await authorizeRequest("operate")
  if (auth.response) return auth.response
  try {
    const params = request.nextUrl.searchParams
    const target = parseTarget(searchParamsObject(params))
    const path = parsePath(params.get("path"))
    const download = await openDownload(await getDocker(), target, path)
    await audit(auth.user, "files.download", describe(target, path))
    const headers: Record<string, string> = {
      "Content-Type": download.kind === "tar" ? "application/x-tar" : "application/octet-stream",
      "Content-Disposition": contentDisposition(download.filename),
      "Cache-Control": "no-store",
    }
    if (download.size !== undefined) headers["Content-Length"] = String(download.size)
    return new Response(toWebStream(download.body, download.cleanup), { headers })
  } catch (err) {
    return errorResponse(err)
  }
}
