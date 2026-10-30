import "server-only"

import crypto from "node:crypto"

/**
 * Interactive console sessions (docker exec, kubectl exec).
 *
 * Next.js route handlers can't accept WebSockets, so a session is a live
 * connection to the container runtime kept in memory here; the browser reads
 * output through a streaming GET and sends keystrokes/resizes with POSTs
 * (see app/api/exec/[sid]/route.ts). Sessions belong to the user who opened
 * them and die when nobody reads them for a short while. The connection
 * itself is a backend (lib/server/docker/exec.ts, lib/server/kubernetes/exec.ts).
 */

const MAX_SESSIONS_PER_USER = 8
const MAX_SESSIONS = 64
const DETACHED_GRACE_MS = 20_000 // reader gone (tab closed, network blip)
const CLOSED_RETENTION_MS = 30_000 // keep finished sessions briefly to drain output
const MAX_LIFETIME_MS = 12 * 60 * 60_000
const MAX_BUFFER_BYTES = 256 * 1024

/** The runtime side of a session. */
export type ExecBackend = {
  write(data: string): void
  /** Best effort: the process may have just exited. */
  resize(cols: number, rows: number): Promise<void>
  /** Closes the connection; safe to call more than once. */
  destroy(): void
  /** The exit code once the process has finished (called after destroy), else null. */
  exitCode(): Promise<number | null>
}

/** Where a backend delivers output and reports that the connection ended. */
export type ExecSink = { data(chunk: Buffer): void; closed(): void }

type Reader = (chunk: Buffer | null) => void

type Session = {
  id: string
  userId: number
  /** Environment the console runs in; access is re-checked against it on every request. */
  environmentId: number
  backend: ExecBackend | null
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
  session.backend?.destroy()
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

/** Refuses a new console when the user or the server already has too many. */
export function assertCapacity(userId: number) {
  const mine = [...sessions.values()].filter((s) => s.userId === userId && !s.closedAt)
  if (mine.length >= MAX_SESSIONS_PER_USER) {
    throw new ExecSessionError("Too many open consoles. Close one and try again.", 429)
  }
  if (sessions.size >= MAX_SESSIONS) {
    throw new ExecSessionError("Too many open consoles on this server.", 429)
  }
}

/**
 * Registers a console for `userId`. `start` gets the sink before any output
 * can arrive (attach the connection's listeners synchronously) and returns
 * the backend. Returns the session id.
 */
export async function registerSession(
  userId: number,
  environmentId: number,
  start: (sink: ExecSink) => Promise<ExecBackend> | ExecBackend
): Promise<string> {
  assertCapacity(userId)
  const session: Session = {
    id: crypto.randomBytes(24).toString("base64url"),
    userId,
    environmentId,
    backend: null,
    buffer: [],
    bufferedBytes: 0,
    reader: null,
    detachedAt: Date.now(),
    createdAt: Date.now(),
    closedAt: null,
  }
  session.backend = await start({ data: (chunk) => push(session, chunk), closed: () => markClosed(session) })
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

/** The environment a session of this user runs in (404 for anyone else). */
export function sessionEnvironment(sid: string, userId: number): number {
  return owned(sid, userId).environmentId
}

/**
 * Ends every console of a user, e.g. after their role, environment access or
 * sessions changed. Returns how many were open.
 */
export function closeUserExecSessions(userId: number): number {
  let n = 0
  for (const s of sessions.values()) {
    if (s.userId !== userId) continue
    if (!s.closedAt) n++
    s.reader?.(null)
    destroy(s)
  }
  return n
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
  session.backend?.write(data)
}

export async function resizeSession(sid: string, userId: number, cols: number, rows: number) {
  const session = owned(sid, userId)
  if (session.closedAt) return
  await session.backend?.resize(cols, rows).catch(() => {})
}

/** Ends the session and reports the exit code when the process has finished. */
export async function closeSession(sid: string, userId: number): Promise<{ exitCode: number | null }> {
  const session = owned(sid, userId)
  destroy(session)
  try {
    return { exitCode: (await session.backend?.exitCode()) ?? null }
  } catch {
    return { exitCode: null }
  }
}
