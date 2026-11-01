import "server-only"

/** What an agent reports about itself and its host when it connects. */
export type AgentInfo = {
  /** Agent script version. */
  version: string
  protocol: number
  /** The Docker host's name (docker info), not the agent container's. */
  hostname: string
  dockerVersion: string
  os: string
  arch: string
  /** The agent's own container on that host, when it runs in one. */
  containerId: string | null
}

/** AgentInfo plus what Gantry saw, stored in environments.agent_info. */
export type StoredAgentInfo = AgentInfo & { remoteAddress: string | null; connectedAt: string }

/** Largest X-Gantry-Agent-Info header accepted (base64url JSON). */
export const MAX_INFO_HEADER = 4096

function text(value: unknown, max = 128): string {
  if (typeof value !== "string") return ""
  // Printable ASCII only: these values end up in the UI and the logs.
  return value.replace(/[^\x20-\x7e]/g, "").trim().slice(0, max)
}

/**
 * Decodes the X-Gantry-Agent-Info header (base64url JSON). Everything in it
 * comes from the remote host, so it is reduced to short printable strings.
 * Returns null when it is missing or malformed.
 */
export function parseAgentInfo(header: string | null): AgentInfo | null {
  if (!header || header.length > MAX_INFO_HEADER || !/^[A-Za-z0-9_-]+$/.test(header)) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(Buffer.from(header, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const protocol = Number(raw.protocol)
  if (!Number.isInteger(protocol) || protocol < 1 || protocol > 1000) return null
  const containerId = typeof raw.containerId === "string" && /^[a-f0-9]{64}$/.test(raw.containerId) ? raw.containerId : null
  return {
    version: text(raw.version, 32) || "unknown",
    protocol,
    hostname: text(raw.hostname) || "unknown",
    dockerVersion: text(raw.dockerVersion, 64),
    os: text(raw.os, 64),
    arch: text(raw.arch, 32),
    containerId,
  }
}

export function encodeAgentInfo(info: Partial<AgentInfo>): string {
  return Buffer.from(JSON.stringify(info), "utf8").toString("base64url")
}

/** The stored JSON, or null when absent or unreadable. */
export function readStoredInfo(value: string | null): StoredAgentInfo | null {
  if (!value) return null
  try {
    const v = JSON.parse(value) as StoredAgentInfo
    return v && typeof v === "object" ? v : null
  } catch {
    return null
  }
}
