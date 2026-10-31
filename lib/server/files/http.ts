import "server-only"

import { DockerError } from "@/lib/server/docker/client"
import { FilesError } from "@/lib/server/files/service"

const NO_STORE = { "Cache-Control": "no-store" }

/** JSON error response for file browser routes; unexpected errors are logged, not shown. */
export function errorResponse(err: unknown): Response {
  if (err instanceof FilesError) {
    return Response.json({ error: err.message, code: err.code }, { status: err.status, headers: NO_STORE })
  }
  if (err instanceof DockerError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502
    return Response.json({ error: err.message }, { status, headers: NO_STORE })
  }
  console.error("[gantry] file browser request failed", err)
  return Response.json({ error: "Something went wrong. Check the server logs." }, { status: 500, headers: NO_STORE })
}

/** attachment; filename="ascii" plus RFC 5987 filename* for anything else. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download"
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Refuses cross-site browser requests (routes that proxy.ts doesn't screen). */
export function crossSite(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site")
  if (site && site !== "same-origin") return Response.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE })
  return null
}

export function searchParamsObject(params: URLSearchParams) {
  return { container: params.get("container") ?? undefined, volume: params.get("volume") ?? undefined }
}
