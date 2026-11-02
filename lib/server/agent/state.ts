import "server-only"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Duplex } from "node:stream"

import { config } from "@/lib/server/config"

/**
 * Process-wide registry of connected agents, shared by the route handlers
 * that carry the tunnel and the Docker client that uses it. Kept on
 * globalThis: route handlers, Server Actions and instrumentation are bundled
 * separately but run in one process. This is why Gantry must run as a single
 * replica when agents are used (an agent is connected to one process only).
 */

/**
 * A live agent session (lib/server/agent/session.ts). Only used through this
 * interface across modules: route handlers, Server Actions and the Docker
 * client may each load their own copy of the class, so never `instanceof`.
 */
export interface LiveAgent {
  readonly id: string
  readonly environmentId: number
  readonly streamCount: number
  readonly closed: boolean
  readonly connectedAt: Date
  readonly remoteAddress: string | null
  readonly rttMs: number | null
  readonly info: { containerId: string | null }
  /** Tunnels a local connection (the Unix socket's, or an in-process one) to the agent's Docker socket. */
  attach(conn: Duplex): void
}

type State = {
  sessions: Map<number, LiveAgent>
  socketDir: string | null
}

const globalForAgents = globalThis as unknown as { __gantryAgentState?: State }

export function agentState(): State {
  return (globalForAgents.__gantryAgentState ??= { sessions: new Map(), socketDir: null })
}

/** Stored as the url of an agent environment, so targets and cache keys stay unique per environment. */
export function agentUrl(environmentId: number) {
  return `agent://${environmentId}`
}

export function agentIdFromUrl(url: string): number | null {
  const m = /^agent:\/\/([1-9][0-9]{0,9})$/.exec(url)
  return m ? Number(m[1]) : null
}

// sun_path is 108 bytes on Linux (104 on macOS); leave room for "<id>.sock".
const MAX_SOCKET_DIR = 88

/**
 * Private directory (0700) for the per-environment Unix sockets that lead
 * into the tunnels: DATA_DIR/agent-sockets, or a fresh temporary directory
 * when that path is too long for a socket.
 */
export function agentSocketDir(): string {
  const state = agentState()
  if (state.socketDir) return state.socketDir
  let dir = path.join(config.dataDir, "agent-sockets")
  if (dir.length > MAX_SOCKET_DIR) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-agent-"))
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
  }
  state.socketDir = dir
  return dir
}

/** Unix socket of an environment's tunnel (DOCKER_HOST for compose; Gantry's own client connects in-process, connect.ts). */
export function agentSocketPath(environmentId: number) {
  return path.join(agentSocketDir(), `${environmentId}.sock`)
}

export const AGENT_NOT_CONNECTED = "The agent of this environment is not connected. Check that the gantry-agent container runs on the host and can reach Gantry."

/** Why Docker can't be reached through an environment's agent right now, or null. */
export function agentProblem(environmentId: number | null): string | null {
  if (environmentId === null) return "Invalid agent environment"
  const live = agentState().sessions.get(environmentId)
  // Over the stream limit, connections wait for a free stream (session.ts).
  return !live || live.closed ? AGENT_NOT_CONNECTED : null
}

/** Containers the connected agents run in: Gantry must not stop or recreate them through themselves. */
export function agentContainerIds(): string[] {
  const ids: string[] = []
  for (const live of agentState().sessions.values()) {
    if (!live.closed && live.info.containerId) ids.push(live.info.containerId)
  }
  return ids
}
