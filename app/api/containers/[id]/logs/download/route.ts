import type http from "node:http"

import type { NextRequest } from "next/server"

import { authorizeRequest } from "@/lib/server/api-auth"
import { FrameDemuxer, dockerStream, toWebStream } from "@/lib/server/docker/stream"
import { getDocker } from "@/lib/server/environments"
import { contentDisposition, errorResponse } from "@/lib/server/files/http"
import { parseLogDownloadOptions } from "@/lib/log-search"

/** Docker's frames carry stdout and stderr; the file gets their payloads in order. */
async function* demuxed(res: http.IncomingMessage): AsyncGenerator<Buffer> {
  const out: Buffer[] = []
  const demux = new FrameDemuxer((_stream, payload) => out.push(payload))
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      demux.push(chunk)
      while (out.length) yield out.shift()!
    }
  } finally {
    res.destroy()
  }
}

// A container's logs as a .log file, streamed (logs can be huge).
// Options: ?timestamps=1, since/until (unix seconds), tail (lines or "all").
// Logs may contain secrets: operators and up, like the log viewer.
export async function GET(request: NextRequest, ctx: RouteContext<"/api/containers/[id]/logs/download">) {
  const auth = await authorizeRequest("operate")
  if (auth.response) return auth.response

  const { id } = await ctx.params
  if (!/^[a-f0-9]{12,64}$/.test(id)) return Response.json({ error: "Invalid container id" }, { status: 400 })
  const options = parseLogDownloadOptions(request.nextUrl.searchParams)
  if ("error" in options) return Response.json({ error: options.error }, { status: 400 })

  try {
    const api = await getDocker()
    const info = await api.inspectContainer(id)
    const res = await dockerStream(api.target, "GET", `/containers/${info.Id}/logs`, {
      query: {
        stdout: 1,
        stderr: 1,
        follow: 0,
        timestamps: options.timestamps ? 1 : 0,
        since: options.since,
        until: options.until,
        tail: options.tail,
      },
      idleTimeoutMs: 5 * 60_000,
      signal: request.signal,
    })
    const name = info.Name.replace(/^\//, "") || id.slice(0, 12)
    const stamp = new Date().toISOString().replace(/[:]/g, "").replace(/\..*$/, "")
    const body = info.Config.Tty ? (res as AsyncIterable<Buffer>) : demuxed(res)
    return new Response(toWebStream(body, () => void res.destroy()), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": contentDisposition(`${name}-${stamp}.log`),
        "Cache-Control": "no-store",
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
