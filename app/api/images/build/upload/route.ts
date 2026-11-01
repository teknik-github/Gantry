import type { NextRequest } from "next/server"

import { BUILD_OPTIONS_HEADER as OPTIONS_HEADER, isArchiveName, MAX_OPTIONS_HEADER, parseBuildOptions, validateDockerfilePath, type FieldErrors } from "@/lib/image-build"
import { expectedEnvironment } from "@/lib/server/action"
import { authorizeRequest } from "@/lib/server/api-auth"
import { formatLimit } from "@/lib/server/images/context"
import { buildLimits, dockerTargetFor, startBuild, uploadProvider } from "@/lib/server/images/run"
import { isCrossSite } from "@/lib/server/same-origin"

const json = (status: number, body: object) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } })

/**
 * Builds from an uploaded context archive (.tar, .tar.gz). The body is the
 * archive itself, streamed to Docker as it arrives (never stored, never
 * buffered); the options come in the X-Gantry-Build-Options header as
 * URI-encoded JSON: { environmentId?, filename, dockerfile, options }.
 * Responds like ../route.ts.
 *
 * proxy.ts skips this path (see its matcher): Next buffers every request
 * body that goes through proxy in memory and silently cuts it at 10 MB. So
 * this handler does proxy's checks itself: a browser session only (no API
 * tokens), same-origin requests only, and the custom header (which a
 * cross-site form can't send) is required.
 */
export async function POST(request: NextRequest) {
  if (isCrossSite(request.headers)) return json(403, { error: "Forbidden" })
  const header = request.headers.get(OPTIONS_HEADER)
  if (!header) return json(400, { error: `The ${OPTIONS_HEADER} header is required` })

  const auth = await authorizeRequest("manage", { sessionOnly: true })
  if (auth.response) return auth.response

  const { maxContextBytes } = buildLimits()
  const length = Number(request.headers.get("content-length") ?? NaN)
  if (Number.isFinite(length) && length > maxContextBytes) {
    return json(413, { error: `The archive is larger than ${formatLimit(maxContextBytes)}`, fieldErrors: { archive: [`At most ${formatLimit(maxContextBytes)}`] } })
  }

  let raw: { environmentId?: unknown; filename?: unknown; dockerfile?: unknown; options?: Record<string, unknown> }
  try {
    if (header.length > MAX_OPTIONS_HEADER) throw new Error("too long")
    raw = JSON.parse(decodeURIComponent(header))
    if (!raw || typeof raw !== "object") throw new Error("not an object")
  } catch {
    return json(400, { error: "Invalid build options" })
  }

  const target = dockerTargetFor(auth.environment, expectedEnvironment(raw.environmentId))
  if (target instanceof Response) return target

  const fieldErrors: FieldErrors = {}
  const options = parseBuildOptions(raw.options ?? {})
  if (!options.ok) Object.assign(fieldErrors, options.fieldErrors)
  const dockerfile = validateDockerfilePath(typeof raw.dockerfile === "string" ? raw.dockerfile : "")
  if (!dockerfile.ok) fieldErrors.uploadDockerfile = [dockerfile.error]
  const filename = typeof raw.filename === "string" ? raw.filename.trim().slice(0, 255) : ""
  if (!isArchiveName(filename)) fieldErrors.archive = ["Choose a .tar or .tar.gz archive"]
  if (!request.body) fieldErrors.archive = ["The archive is empty"]
  if (!options.ok || !dockerfile.ok || Object.keys(fieldErrors).length) {
    return json(400, { error: "Please fix the highlighted fields", fieldErrors })
  }

  const size = Number.isFinite(length) ? length : null
  return startBuild({
    user: auth.user,
    environment: auth.environment!,
    target,
    source: { kind: "upload", filename, dockerfile: dockerfile.value, ...(size !== null ? { size } : {}) },
    options: options.value,
    context: uploadProvider(request.body!, dockerfile.value, size),
    requestSignal: request.signal,
  })
}
