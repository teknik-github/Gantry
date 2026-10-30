// Pure helpers for container registries: which registry an image reference
// points at, how registry addresses are normalised, and the auth formats the
// Docker Engine API (X-Registry-Auth) and the docker CLI (config.json) expect.

export const DOCKER_HUB = "docker.io"

/** Docker Hub's key in ~/.docker/config.json (the CLI ignores "docker.io"). */
const DOCKER_HUB_CONFIG_KEY = "https://index.docker.io/v1/"

const HUB_ALIASES = new Set(["docker.io", "index.docker.io", "registry-1.docker.io", "registry.hub.docker.com", "hub.docker.com"])

/** host[:port], lowercase; null when the text isn't a registry address. */
export function normalizeRegistryAddress(input: string): string | null {
  let text = input.trim().toLowerCase()
  if (!text) return null
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  // Drop a path such as "/v1/" or "/v2/".
  text = text.replace(/\/.*$/, "")
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(text)) return null
  const port = text.match(/:(\d+)$/)?.[1]
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null
  return HUB_ALIASES.has(text) ? DOCKER_HUB : text
}

/**
 * Registry host of an image reference, like Docker resolves it: the first
 * path component is a registry when it contains "." or ":" or is
 * "localhost"; otherwise the image lives on Docker Hub.
 */
export function registryOf(reference: string): string {
  const ref = reference.trim()
  const slash = ref.indexOf("/")
  if (slash < 0) return DOCKER_HUB
  const first = ref.slice(0, slash)
  if (first === "localhost" || first.includes(".") || first.includes(":")) {
    return normalizeRegistryAddress(first) ?? first.toLowerCase()
  }
  return DOCKER_HUB
}

export type RegistryCredentials = { address: string; username: string; password: string }

/** The `serveraddress` / config.json key Docker uses for a registry. */
export function registryServerAddress(address: string) {
  return address === DOCKER_HUB ? DOCKER_HUB_CONFIG_KEY : address
}

/**
 * Value of the Engine API's X-Registry-Auth header: base64url JSON *with*
 * padding. Docker decodes it with Go's padded URL alphabet and silently
 * drops credentials it can't decode, so Node's unpadded "base64url" breaks
 * logins whose JSON length isn't a multiple of 3.
 */
export function registryAuthHeader(cred: RegistryCredentials): string {
  const json = JSON.stringify({
    username: cred.username,
    password: cred.password,
    serveraddress: registryServerAddress(cred.address),
  })
  return Buffer.from(json, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_")
}

/** ~/.docker/config.json content giving the docker CLI (compose) these logins. */
export function dockerConfigJson(creds: RegistryCredentials[]): string {
  const auths: Record<string, { auth: string }> = {}
  for (const c of creds) {
    auths[registryServerAddress(c.address)] = { auth: Buffer.from(`${c.username}:${c.password}`, "utf8").toString("base64") }
  }
  return `${JSON.stringify({ auths }, null, 2)}\n`
}
