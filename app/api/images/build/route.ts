import type { NextRequest } from "next/server"

import { allowHttpLoopback } from "@/lib/git-stacks"
import {
  MAX_BUILD_REQUEST_BYTES,
  parseBuildOptions,
  validateEditorSource,
  validateGitBuildSource,
  type FieldErrors,
} from "@/lib/image-build"
import { expectedEnvironment } from "@/lib/server/action"
import { authorizeRequest } from "@/lib/server/api-auth"
import { json } from "@/lib/server/http"
import { dockerTargetFor, editorProvider, gitProvider, startBuild } from "@/lib/server/images/run"
import { checkCredentials } from "@/lib/server/stacks/git"

/**
 * Builds an image on the current environment from a Dockerfile written in
 * the editor (plus a few small files) or from a Git repository. JSON body:
 *   { environmentId?, source: { kind: "editor", dockerfile, files: [{ path, content }] }
 *                           | { kind: "git", url, ref, context, dockerfile, username?, token? },
 *     options: { tags, buildArgs, labels, target, noCache, pull, push } }
 * (tags, buildArgs and labels as typed: one per line). Responds with the
 * build's events as JSON lines (BuildStreamEvent, lib/image-build.ts);
 * closing the request cancels the build. Uploaded archives go to ./upload.
 * Needs the manager role; API tokens work too.
 */
export async function POST(request: NextRequest) {
  const auth = await authorizeRequest("manage")
  if (auth.response) return auth.response

  if (Number(request.headers.get("content-length") ?? 0) > MAX_BUILD_REQUEST_BYTES) {
    return json(413, { error: "The request is too large; upload an archive instead" })
  }
  const text = await request.text().catch(() => "")
  if (text.length > MAX_BUILD_REQUEST_BYTES) return json(413, { error: "The request is too large; upload an archive instead" })
  let body: { environmentId?: unknown; source?: Record<string, unknown>; options?: Record<string, unknown> }
  try {
    body = JSON.parse(text)
  } catch {
    return json(400, { error: "Send the build as JSON" })
  }
  if (!body || typeof body !== "object" || !body.source || typeof body.source !== "object") {
    return json(400, { error: "The build source is missing" })
  }

  const target = dockerTargetFor(auth.environment, expectedEnvironment(body.environmentId))
  if (target instanceof Response) return target

  const options = parseBuildOptions(body.options ?? {})
  const fieldErrors: FieldErrors = options.ok ? {} : { ...options.fieldErrors }
  const kind = body.source.kind

  if (kind === "editor") {
    const source = validateEditorSource(body.source)
    if (!source.ok) Object.assign(fieldErrors, source.fieldErrors)
    if (!source.ok || !options.ok) return json(400, { error: "Please fix the highlighted fields", fieldErrors })
    return startBuild({
      user: auth.user,
      environment: auth.environment!,
      target,
      source: source.value,
      options: options.value,
      context: editorProvider(source.value),
      requestSignal: request.signal,
    })
  }

  if (kind === "git") {
    const source = validateGitBuildSource(body.source, { allowHttpLoopback: allowHttpLoopback() })
    if (!source.ok) Object.assign(fieldErrors, source.fieldErrors)
    const username = typeof body.source.username === "string" ? body.source.username.trim() : ""
    const token = typeof body.source.token === "string" ? body.source.token.trim() : ""
    const credError = checkCredentials(username, token)
    if (credError) fieldErrors[username ? "token" : "username"] = [credError]
    if (!source.ok || !options.ok || credError) return json(400, { error: "Please fix the highlighted fields", fieldErrors })
    return startBuild({
      user: auth.user,
      environment: auth.environment!,
      target,
      source: source.value,
      options: options.value,
      // Used for this clone only; never stored.
      context: gitProvider(source.value, username ? { username, token } : null),
      requestSignal: request.signal,
    })
  }

  return json(400, { error: 'source.kind must be "editor" or "git" (archives are sent to /api/images/build/upload)' })
}
