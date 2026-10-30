import "server-only"

import type { Duplex } from "node:stream"

import {
  connectionError,
  dockerJson,
  dockerRaw,
  dockerRequest,
  DockerError,
  type DockerTarget,
} from "@/lib/server/docker/client"
import { assertCapacity, registerSession } from "@/lib/server/exec-sessions"

// The session plumbing is shared with Kubernetes consoles; the route
// handlers (app/api/exec/[sid]) import it from here.
export {
  closeSession,
  closeUserExecSessions,
  ExecSessionError,
  openOutputStream,
  resizeSession,
  sessionEnvironment,
  writeInput,
} from "@/lib/server/exec-sessions"

/**
 * Interactive `docker exec` sessions: a hijacked TTY connection to the
 * daemon, registered as a console session (lib/server/exec-sessions.ts).
 */

/** Starts the exec with a hijacked connection: raw TTY bytes in both directions. */
function hijack(target: DockerTarget, path: string, body: unknown): Promise<Duplex> {
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = dockerRequest(target, {
      method: "POST",
      path,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": payload.length,
        Connection: "Upgrade",
        Upgrade: "tcp",
      },
    })
    const timer = setTimeout(() => req.destroy(new DockerError("Docker did not start the exec in time", 504)), 15_000)

    req.on("upgrade", (_res, socket, head) => {
      clearTimeout(timer)
      socket.setTimeout(0)
      socket.setKeepAlive(true, 30_000)
      if (head.length) socket.unshift(head)
      resolve(socket)
    })
    req.on("response", (res) => {
      // Anything but 101 Switching Protocols is an error.
      clearTimeout(timer)
      const chunks: Buffer[] = []
      res.on("data", (c: Buffer) => chunks.push(c))
      res.on("end", () => {
        let message = Buffer.concat(chunks).toString("utf8").trim()
        try {
          message = JSON.parse(message).message ?? message
        } catch {}
        reject(new DockerError(message || `Docker exec failed (${res.statusCode})`, res.statusCode ?? 502))
      })
    })
    req.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(connectionError(err))
    })
    req.end(payload)
  })
}

export async function openExecSession(opts: {
  userId: number
  /** Environment the console runs in (access is re-checked against it). */
  environmentId: number
  target: DockerTarget
  containerId: string
  cmd: string[]
  user?: string
  cols: number
  rows: number
}): Promise<string> {
  assertCapacity(opts.userId)

  const { Id: execId } = await dockerJson<{ Id: string }>(
    opts.target,
    "POST",
    `/containers/${encodeURIComponent(opts.containerId)}/exec`,
    {
      body: {
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        Cmd: opts.cmd,
        User: opts.user || undefined,
        Env: ["TERM=xterm-256color"],
      },
    }
  )

  const socket = await hijack(opts.target, `/exec/${execId}/start`, {
    Detach: false,
    Tty: true,
    ConsoleSize: [opts.rows, opts.cols],
  })

  return registerSession(opts.userId, opts.environmentId, (sink) => {
    socket.on("data", (chunk: Buffer) => sink.data(chunk))
    socket.on("close", () => sink.closed())
    socket.on("error", () => sink.closed())
    return {
      write: (data) => void socket.write(data),
      async resize(cols, rows) {
        await dockerRaw(opts.target, "POST", `/exec/${execId}/resize`, { query: { h: rows, w: cols }, timeoutMs: 5_000 })
      },
      destroy: () => socket.destroy(),
      async exitCode() {
        const info = await dockerJson<{ Running: boolean; ExitCode: number | null }>(
          opts.target,
          "GET",
          `/exec/${execId}/json`,
          { timeoutMs: 5_000 }
        )
        return info.Running ? null : info.ExitCode
      },
    }
  })
}
