import { registryServerAddress, type RegistryCredentials } from "@/lib/registry"

/**
 * Value of the Engine API's X-Registry-Config header for POST /build: every
 * stored login, keyed by registry, so FROM can pull private base images.
 * Like X-Registry-Auth (see registryAuthHeader in lib/registry.ts) it must
 * be base64url *with* padding: Docker decodes it with Go's padded URL
 * alphabet and silently builds without credentials when that fails.
 */
export function registryConfigHeader(creds: RegistryCredentials[]): string {
  const config: Record<string, { username: string; password: string; serveraddress: string }> = {}
  for (const c of creds) {
    const key = registryServerAddress(c.address)
    config[key] = { username: c.username, password: c.password, serveraddress: key }
  }
  return paddedBase64Url(JSON.stringify(config))
}

/** base64url keeping the "=" padding (Node's "base64url" drops it). */
export function paddedBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_")
}
