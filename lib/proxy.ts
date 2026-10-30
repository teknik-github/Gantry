// Reverse proxy hosts (domain → container:port). Pure helpers: validation,
// the Caddyfile Gantry's built-in proxy runs, and config snippets for an
// external proxy. Container management is in lib/server/proxy.ts.

export const PROXY_MODES = ["off", "internal", "external"] as const
export type ProxyMode = (typeof PROXY_MODES)[number]

export const TLS_MODES = {
  auto: { label: "Let's Encrypt", description: "Public domain; ports 80/443 must reach the proxy" },
  internal: { label: "Self-signed", description: "Caddy's local CA (LAN, testing)" },
  off: { label: "HTTP only", description: "No TLS" },
} as const
export type TlsMode = keyof typeof TLS_MODES
export const TLS_MODE_KEYS = Object.keys(TLS_MODES) as TlsMode[]

export type ProxyHost = {
  domains: string[]
  /** Container name (Docker DNS name on the proxy network). */
  target: string
  port: number
  tls: TlsMode
  enabled: boolean
}

export type ProxySettings = {
  mode: ProxyMode
  httpPort: number
  httpsPort: number
  /** Let's Encrypt account email (optional). */
  email: string
  /** External mode: the Docker network the existing proxy is on. */
  externalNetwork: string
}

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

/** Lowercased hostname, or null. Allows one leading "*." wildcard label. */
export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/\.$/, "")
  if (!d || d.length > 253) return null
  const labels = d.split(".")
  if (labels.length < 2 && d !== "localhost") return null
  return labels.every((l, i) => (i === 0 && l === "*" && labels.length > 2) || LABEL_RE.test(l)) ? d : null
}

/** Splits "a.com, b.com" / newlines into normalized domains; reports the bad ones. */
export function parseDomains(text: string): { domains: string[]; invalid: string[] } {
  const domains: string[] = []
  const invalid: string[] = []
  for (const raw of text.split(/[\s,]+/).filter(Boolean)) {
    const d = normalizeDomain(raw)
    if (!d) invalid.push(raw)
    else if (!domains.includes(d)) domains.push(d)
  }
  return { domains, invalid }
}

export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/
export const NETWORK_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const EMAIL_RE = /^[^\s@"'{}]+@[^\s@"'{}]+\.[^\s@"'{}]+$/

export function checkHost(
  host: { domains: string; target: string; port: string; tls: string },
  others: { id: number; domains: string[] }[],
  selfId?: number
): { host?: Omit<ProxyHost, "enabled">; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const { domains, invalid } = parseDomains(host.domains)
  if (invalid.length) errors.domains = `Not a valid domain: ${invalid.join(", ")}`
  else if (!domains.length) errors.domains = "Add at least one domain"
  else if (domains.length > 20) errors.domains = "At most 20 domains per host"
  const taken = domains.filter((d) => others.some((o) => o.id !== selfId && o.domains.includes(d)))
  if (!errors.domains && taken.length) errors.domains = `Already used by another host: ${taken.join(", ")}`
  const tls = host.tls as TlsMode
  if (!TLS_MODE_KEYS.includes(tls)) errors.tls = "Pick a TLS mode"
  else if (tls === "auto" && domains.some((d) => d.startsWith("*.") || d === "localhost" || d.endsWith(".localhost") || d.endsWith(".local") || d.endsWith(".lan"))) {
    errors.tls = "Let's Encrypt needs public domains (no wildcards or .local/.lan/.localhost); use Self-signed"
  }
  if (!CONTAINER_NAME_RE.test(host.target)) errors.target = "Pick a container"
  const port = Number(host.port)
  if (!/^\d{1,5}$/.test(host.port) || port < 1 || port > 65535) errors.port = "1-65535"
  if (Object.keys(errors).length) return { errors }
  return { host: { domains, target: host.target, port, tls }, errors }
}

export function checkSettings(input: Record<string, string | undefined>): { settings?: ProxySettings; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const mode = input.mode as ProxyMode
  if (!PROXY_MODES.includes(mode)) errors.mode = "Pick a mode"
  const portOf = (key: string, def: number) => {
    const raw = (input[key] ?? "").trim() || String(def)
    const n = Number(raw)
    if (!/^\d{1,5}$/.test(raw) || n < 1 || n > 65535) errors[key] = "1-65535"
    return n
  }
  const httpPort = portOf("httpPort", 80)
  const httpsPort = portOf("httpsPort", 443)
  if (!errors.httpPort && !errors.httpsPort && httpPort === httpsPort) errors.httpsPort = "Must differ from the HTTP port"
  const email = (input.email ?? "").trim()
  if (email && (!EMAIL_RE.test(email) || email.length > 254)) errors.email = "Not a valid email"
  const externalNetwork = (input.externalNetwork ?? "").trim()
  if (mode === "external" && !NETWORK_NAME_RE.test(externalNetwork)) errors.externalNetwork = "The Docker network your proxy is attached to"
  if (Object.keys(errors).length) return { errors }
  return { settings: { mode, httpPort, httpsPort, email, externalNetwork }, errors }
}

/** Site address list for a host: http:// prefix when TLS is off. */
function siteAddress(h: ProxyHost) {
  return h.domains.map((d) => (h.tls === "off" ? `http://${d}` : d)).join(", ")
}

/**
 * Caddyfile for the built-in proxy. Every value comes from validated input
 * (domains, container names, ports, email), so nothing can inject directives.
 */
export function buildCaddyfile(hosts: ProxyHost[], settings: Pick<ProxySettings, "email">) {
  const lines = ["# Generated by Gantry: changes made here are overwritten.", "{"]
  if (settings.email) lines.push(`\temail ${settings.email}`)
  lines.push("\tadmin localhost:2019", "}", "")
  const active = hosts.filter((h) => h.enabled && h.domains.length)
  for (const h of active) {
    lines.push(`${siteAddress(h)} {`)
    if (h.tls === "internal") lines.push("\ttls internal")
    lines.push(`\treverse_proxy ${h.target}:${h.port}`, "}", "")
  }
  if (!active.length) lines.push("# No proxy hosts yet.", ":80 {", '\trespond "Gantry proxy: no hosts configured" 404', "}", "")
  return lines.join("\n")
}

/** Ready-to-paste config for an existing proxy (external mode). */
export function externalSnippets(h: ProxyHost & { id: number }, network: string) {
  const router = `gantry-${h.id}`
  const rule = h.domains.map((d) => (d.startsWith("*.") ? `HostRegexp(\`^.+\\.${d.slice(2).replace(/\./g, "\\.")}$\`)` : `Host(\`${d}\`)`)).join(" || ")
  const traefik = [
    "traefik.enable=true",
    `traefik.docker.network=${network}`,
    `traefik.http.routers.${router}.rule=${rule}`,
    ...(h.tls === "off" ? [] : [`traefik.http.routers.${router}.tls=true`]),
    ...(h.tls === "auto" ? [`traefik.http.routers.${router}.tls.certresolver=letsencrypt`] : []),
    `traefik.http.services.${router}.loadbalancer.server.port=${h.port}`,
  ].join("\n")
  const caddy = `${siteAddress(h)} {\n${h.tls === "internal" ? "\ttls internal\n" : ""}\treverse_proxy ${h.target}:${h.port}\n}`
  const nginx = [
    "server {",
    `    listen ${h.tls === "off" ? "80" : "443 ssl"};`,
    `    server_name ${h.domains.join(" ")};`,
    ...(h.tls === "off" ? [] : ["    # ssl_certificate / ssl_certificate_key: your certificates"]),
    "    location / {",
    `        proxy_pass http://${h.target}:${h.port};`,
    "        proxy_set_header Host $host;",
    "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;",
    "        proxy_set_header X-Forwarded-Proto $scheme;",
    "        proxy_http_version 1.1;",
    "        proxy_set_header Upgrade $http_upgrade;",
    '        proxy_set_header Connection "upgrade";',
    "    }",
    "}",
  ].join("\n")
  return { traefik, caddy, nginx }
}
