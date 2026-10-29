import type { NextRequest } from "next/server"
import { z } from "zod"

import { getCurrentUser } from "@/lib/server/auth/dal"
import {
  closeSession,
  ExecSessionError,
  openOutputStream,
  resizeSession,
  writeInput,
} from "@/lib/server/docker/exec"

// Console I/O for sessions opened by startExecSession (containers/actions.ts).
// proxy.ts already requires a session for /api/*; each handler also checks the
// user is still an administrator and owns the console session.

async function requireAdmin() {
  const user = await getCurrentUser()
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) }
  if (user.role !== "admin") return { error: Response.json({ error: "Forbidden" }, { status: 403 }) }
  return { user }
}

function failure(err: unknown) {
  if (err instanceof ExecSessionError) return Response.json({ error: err.message }, { status: err.status })
  console.error("[gantry] exec api error", err)
  return Response.json({ error: "Internal error" }, { status: 500 })
}

/** Terminal output as a raw byte stream. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/exec/[sid]">) {
  const { user, error } = await requireAdmin()
  if (error) return error
  const { sid } = await ctx.params

  try {
    const stream = openOutputStream(sid, user.id, request.signal)
    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        // no-transform keeps compression from buffering the stream.
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    })
  } catch (err) {
    return failure(err)
  }
}

const inputSchema = z.union([
  z.object({ data: z.string().min(1).max(64 * 1024) }),
  z.object({ cols: z.number().int().min(10).max(500), rows: z.number().int().min(4).max(200) }),
])

/** Keystrokes ({ data }) or a terminal resize ({ cols, rows }). */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/exec/[sid]">) {
  const { user, error } = await requireAdmin()
  if (error) return error
  const { sid } = await ctx.params

  const parsed = inputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: "Invalid input" }, { status: 400 })

  try {
    if ("data" in parsed.data) writeInput(sid, user.id, parsed.data.data)
    else await resizeSession(sid, user.id, parsed.data.cols, parsed.data.rows)
    return new Response(null, { status: 204 })
  } catch (err) {
    return failure(err)
  }
}

/** Ends the console; returns the exit code if the shell already finished. */
export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/exec/[sid]">) {
  const { user, error } = await requireAdmin()
  if (error) return error
  const { sid } = await ctx.params

  try {
    return Response.json(await closeSession(sid, user.id))
  } catch (err) {
    return failure(err)
  }
}
