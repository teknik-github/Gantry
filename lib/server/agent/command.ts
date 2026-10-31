import "server-only"

/** Image the agent runs from: the Gantry image itself (`<image> agent`). */
export function agentImage(env: NodeJS.ProcessEnv = process.env) {
  return env.GANTRY_AGENT_IMAGE?.trim() || "gantry:latest"
}

type HeaderGetter = { get(name: string): string | null }

/**
 * The address agents should use: GANTRY_URL when set (recommended), else
 * what the admin's browser used to reach Gantry.
 */
export function gantryPublicUrl(headers: HeaderGetter, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.GANTRY_URL?.trim()
  if (configured && /^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, "")
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost:3000").split(",")[0].trim()
  const proto = (headers.get("x-forwarded-proto") ?? "http").split(",")[0].trim().toLowerCase() === "https" ? "https" : "http"
  return `${proto}://${host}`
}

/** Single-quotes a value for a POSIX shell when it needs it. */
export function shellQuote(value: string) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`
}

/** Whether the agent will refuse this URL without GANTRY_AGENT_INSECURE=1 (plain http to a non-loopback host). */
export function needsInsecure(url: string) {
  try {
    const u = new URL(url)
    return u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
  } catch {
    return false
  }
}

/** The `docker run` command shown once with a new key. */
export function agentRunCommand(opts: { url: string; key: string; image?: string }) {
  return [
    "docker run -d --name gantry-agent --restart unless-stopped --user root",
    "  -v /var/run/docker.sock:/var/run/docker.sock",
    `  -e GANTRY_URL=${shellQuote(opts.url)}`,
    `  -e GANTRY_AGENT_KEY=${shellQuote(opts.key)}`,
    `  ${shellQuote(opts.image ?? agentImage())} agent`,
  ].join(" \\\n")
}
