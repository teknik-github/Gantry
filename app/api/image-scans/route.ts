import type { NextRequest } from "next/server"

import { authorizeRequest } from "@/lib/server/api-auth"
import { scanSummaries } from "@/lib/server/image-scans"

// Scan state of the current environment's images (counts, queued/running),
// polled by the Images page while scans are pending. Viewers may read it.
export async function GET(request: NextRequest) {
  const auth = await authorizeRequest("view")
  if (auth.response) return auth.response
  const env = auth.environment
  const headers = { "Cache-Control": "no-store" }
  if (!env || env.type === "kubernetes") return Response.json({ environmentId: env?.id ?? null, scans: [] }, { headers })
  // The page passes the environment it shows; refuse to answer for another one.
  const wanted = request.nextUrl.searchParams.get("environment")
  if (wanted && wanted !== String(env.id)) {
    return Response.json({ error: "The environment changed" }, { status: 409, headers })
  }
  return Response.json({ environmentId: env.id, scans: await scanSummaries(env.id) }, { headers })
}
