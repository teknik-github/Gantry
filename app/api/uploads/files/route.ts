import { Readable } from "node:stream"

import type { NextRequest } from "next/server"

import { ENVIRONMENT_SWITCHED } from "@/lib/messages"
import { expectedEnvironment } from "@/lib/server/action"
import { authorizeRequest } from "@/lib/server/api-auth"
import { audit } from "@/lib/server/audit"
import { getDocker } from "@/lib/server/environments"
import { filesConfig } from "@/lib/server/files/config"
import { crossSite, errorResponse, searchParamsObject } from "@/lib/server/files/http"
import { describe, parseName, parsePath, parseTarget, uploadFile } from "@/lib/server/files/service"

/**
 * Uploads one file into a folder of a container or volume: the raw file is
 * the request body (Content-Length required), streamed into Docker as a tar
 * archive without buffering. ?mode=edit saves the text editor's content
 * (FILES_EDIT_MAX_KB) instead of an upload (FILES_UPLOAD_MAX_MB).
 *
 * /api/uploads/* bypasses proxy.ts (see its matcher), which would buffer
 * the body in memory and silently cut it at 10 MB; so this handler does the
 * proxy's checks itself: a same-origin browser session, never an API token.
 * Managers only, pinned to the environment the page showed; audited.
 */
export async function PUT(request: NextRequest) {
  const forbidden = crossSite(request)
  if (forbidden) return forbidden
  const auth = await authorizeRequest("manage", { sessionOnly: true })
  if (auth.response) return auth.response

  const params = request.nextUrl.searchParams
  const expected = expectedEnvironment(params.get("env"))
  if (expected !== undefined && auth.environment?.id !== expected) {
    return Response.json({ error: ENVIRONMENT_SWITCHED }, { status: 409 })
  }

  const edit = params.get("mode") === "edit"
  const { uploadMaxBytes, editMaxBytes } = filesConfig()
  const max = edit ? editMaxBytes : uploadMaxBytes
  const length = Number(request.headers.get("content-length"))
  if (!request.headers.has("content-length") || !Number.isSafeInteger(length) || length < 0) {
    return Response.json({ error: "Content-Length is required" }, { status: 411 })
  }
  if (length > max) {
    const limit = edit ? `${Math.round(max / 1024)} KB (FILES_EDIT_MAX_KB)` : `${Math.round(max / 1024 / 1024)} MB (FILES_UPLOAD_MAX_MB)`
    return Response.json({ error: `The file is larger than the limit of ${limit}` }, { status: 413 })
  }

  try {
    const target = parseTarget(searchParamsObject(params))
    const dir = parsePath(params.get("path"))
    const name = parseName(params.get("name"))
    const body = request.body ? Readable.fromWeb(request.body as import("node:stream/web").ReadableStream<Uint8Array>) : Readable.from([])
    await uploadFile(await getDocker(), target, {
      dir,
      name,
      size: length,
      body,
      overwrite: params.get("overwrite") === "1",
    })
    await audit(auth.user, edit ? "files.edit" : "files.upload", describe(target, `${dir === "/" ? "" : dir}/${name}`))
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    return errorResponse(err)
  }
}
