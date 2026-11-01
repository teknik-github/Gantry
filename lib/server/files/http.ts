import "server-only"

import { FilesError } from "@/lib/server/files/service"
import { errorResponse as routeErrorResponse, json } from "@/lib/server/http"
import { isCrossSite } from "@/lib/server/same-origin"

/**
 * JSON error response for file browser routes: FilesError with its status
 * and code, Docker errors and unexpected ones like every route handler
 * (lib/server/http.ts).
 */
export function errorResponse(err: unknown): Response {
  if (err instanceof FilesError) return json(err.status, { error: err.message, code: err.code })
  return routeErrorResponse(err, "file browser request")
}

/** attachment; filename="ascii" plus RFC 5987 filename* for anything else. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download"
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/** Refuses cross-site browser requests (routes that proxy.ts doesn't screen). */
export function crossSite(request: Request): Response | null {
  return isCrossSite(request.headers) ? json(403, { error: "Forbidden" }) : null
}

export function searchParamsObject(params: URLSearchParams) {
  return { container: params.get("container") ?? undefined, volume: params.get("volume") ?? undefined }
}
