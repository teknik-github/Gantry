import "server-only"

import crypto from "node:crypto"
import http from "node:http"
import type { Duplex } from "node:stream"

import {
  connectionOptions,
  dockerJson,
  dockerRaw,
  DockerError,
  type DockerTarget,
} from "@/lib/server/docker/client"

/**
 * Interactive `docker exec` sessions.
 *
 * Next.js route handlers can't accept WebSockets, so a session is a hijacked
 * TTY connection to the Docker daemon kept in memory here; the browser reads
 * output through a streaming GET and sends keystrokes/resizes with POSTs
 * (see app/api/exec/[sid]/route.ts). Sessions belong to the user who opened
 * them and die when nobody reads them for a short while.
 */

const MAX_SESSIONS_PER_USER = 8
const MAX_SESSIONS = 64
const DETACHED_GRACE_MS = 20_000 // reader gone (tab closed, network blip)
const CLOSED_RETENTION_MS = 30_000 // keep finished sessions briefly to drain output
const MAX_LIFETIME_MS = 12 * 60 * 60_000
const MAX_BUFFER_BYTES = 256 * 1024

type Reader = (chunk: Buffer | null) => void

type Session = {
  id: string
  userId: number
  containerId: string
  execId: string
  target: DockerTarget
  socket: Duplex
  buffer: Buffer[]
  bufferedBytes: number
  reader: Reader | null
  detachedAt: number | null
  createdAt: number
  closedAt: number | null
}

const globalForExec = globalThis as unknown as {
  __gantryExecSessions?: Map<string, Session>
  __gantryExecSweeper?: NodeJS.Timeout
}
const sessions = (globalForExec.__gantryExecSessions ??= new Map<string, Session>())

export class ExecSessionError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message)
  }
}

/** Starts the exec with a hijacked connection: raw TTY bytes in both directions. */
function hijack(target: DockerTarget, path: string, body: unknown): Promise<Duplex> {
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = http.request({
      ...connectionOptions(target),
      method: "POST",
      path,
      headers: {
        Host: "docker",
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
      reject(err instanceof DockerError ? err : new DockerError(`Cannot reach Docker (${err.code ?? err.message})`, 502))
    })
    req.end(payload)
  })
}

function push(session: Session, chunk: Buffer) {
  if (session.reader) {
    session.reader(chunk)
    return
  }
  session.buffer.push(chunk)
  session.bufferedBytes += chunk.length
  while (session.bufferedBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
    session.bufferedBytes -= session.buffer.shift()!.length
  }
}

function markClosed(session: Session) {
  if (session.closedAt) return
  session.closedAt = Date.now()
  session.reader?.(null)
  session.reader = null
}

function destroy(session: Session) {
  markClosed(session)
  session.socket.destroy()
  sessions.delete(session.id)
}

function startSweeper() {
  if (globalForExec.__gantryExecSweeper) return
  const timer = setInterval(() => {
    const now = Date.now()
    for (const s of sessions.values()) {
      if (s.closedAt && now - s.closedAt > CLOSED_RETENTION_MS) sessions.delete(s.id)
      else if (!s.reader && s.detachedAt && now - s.detachedAt > DETACHED_GRACE_MS) destroy(s)
      else if (now - s.createdAt > MAX_LIFETIME_MS) destroy(s)
    }
  }, 5_000)
  timer.unref()
  globalForExec.__gantryExecSweeper = timer
}

export async function openExecSession(opts: {
  userId: number
  target: DockerTarget
  containerId: string
  cmd: string[]
  user?: string
  cols: number
  rows: number
}): Promise<string> {
  const mine = [...sessions.values()].filter((s) => s.userId === opts.userId && !s.closedAt)
  if (mine.length >= MAX_SESSIONS_PER_USER) {
    throw new ExecSessionError("Too many open consoles. Close one and try again.", 429)
  }
  if (sessions.size >= MAX_SESSIONS) {
    throw new ExecSessionError("Too many open consoles on this server.", 429)
  }

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

  const session: Session = {
    id: crypto.randomBytes(24).toString("base64url"),
    userId: opts.userId,
    containerId: opts.containerId,
    execId,
    target: opts.target,
    socket,
    buffer: [],
    bufferedBytes: 0,
    reader: null,
    detachedAt: Date.now(),
    createdAt: Date.now(),
    closedAt: null,
  }
  socket.on("data", (chunk: Buffer) => push(session, chunk))
  socket.on("close", () => markClosed(session))
  socket.on("error", () => markClosed(session))

  sessions.set(session.id, session)
  startSweeper()
  return session.id
}

/** Looks a session up for its owner; other users get "not found", never a hint it exists. */
function owned(sid: string, userId: number) {
  const session = sessions.get(sid)
  if (!session || session.userId !== userId) {
    throw new ExecSessionError("Console session not found", 404)
  }
  return session
}

/**
 * Streams the session's output. A session has a single reader: attaching
 * again (e.g. a reconnect) ends the previous stream.
 */
export function openOutputStream(sid: string, userId: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const session = owned(sid, userId)
  let reader: Reader | null = null

  const detach = () => {
    if (session.reader === reader) {
      session.reader = null
      session.detachedAt = Date.now()
    }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      session.reader?.(null)
      let open = true
      reader = (chunk) => {
        if (!open) return
        if (chunk) {
          controller.enqueue(new Uint8Array(chunk))
        } else {
          open = false
          detach()
          controller.close()
        }
      }

      for (const chunk of session.buffer) controller.enqueue(new Uint8Array(chunk))
      session.buffer = []
      session.bufferedBytes = 0

      if (session.closedAt) {
        open = false
        controller.close()
        return
      }
      session.reader = reader
      session.detachedAt = null
      signal.addEventListener("abort", () => reader?.(null), { once: true })
    },
    cancel() {
      detach()
    },
  })
}

export function writeInput(sid: string, userId: number, data: string) {
  const session = owned(sid, userId)
  if (session.closedAt) throw new ExecSessionError("The console has exited", 410)
  session.socket.write(data)
}

export async function resizeSession(sid: string, userId: number, cols: number, rows: number) {
  const session = owned(sid, userId)
  if (session.closedAt) return
  await dockerRaw(session.target, "POST", `/exec/${session.execId}/resize`, {
    query: { h: rows, w: cols },
    timeoutMs: 5_000,
  }).catch(() => {
    // The process may have just exited; resizing is best effort.
  })
}

/** Ends the session and reports the exit code when the process has finished. */
export async function closeSession(sid: string, userId: number): Promise<{ exitCode: number | null }> {
  const session = owned(sid, userId)
  destroy(session)
  try {
    const info = await dockerJson<{ Running: boolean; ExitCode: number | null }>(
      session.target,
      "GET",
      `/exec/${session.execId}/json`,
      { timeoutMs: 5_000 }
    )
    return { exitCode: info.Running ? null : info.ExitCode }
  } catch {
    return { exitCode: null }
  }
}
