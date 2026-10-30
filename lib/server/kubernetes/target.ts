import "server-only"

import { decryptSecret, encryptSecret, SecretDecryptError } from "@/lib/server/crypto"
import type { Environment } from "@/lib/server/db/schema"
import { KubeError, type KubeTarget } from "@/lib/server/kubernetes/client"

/** What is stored (encrypted) in environments.kube_credentials. */
export type KubeCredentials = {
  token?: string
  cert?: string
  key?: string
  ca?: string
}

export type KubeEnvironmentRow = Pick<Environment, "type" | "url" | "kube_credentials" | "kube_insecure">

// Bound as AAD so the value only decrypts in its own column.
const CONTEXT = "environment.kube_credentials"

export function encryptKubeCredentials(credentials: KubeCredentials): string {
  const clean: KubeCredentials = {}
  for (const k of ["token", "cert", "key", "ca"] as const) if (credentials[k]) clean[k] = credentials[k]
  return encryptSecret(JSON.stringify(clean), CONTEXT)
}

export function decryptKubeCredentials(env: Pick<Environment, "kube_credentials">): KubeCredentials {
  if (!env.kube_credentials) return {}
  try {
    const parsed = JSON.parse(decryptSecret(env.kube_credentials, CONTEXT)) as KubeCredentials
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch (err) {
    if (err instanceof SecretDecryptError || err instanceof SyntaxError) {
      throw new KubeError(
        "The stored Kubernetes credentials can't be decrypted (was GANTRY_SECRET changed?). Edit the environment and enter them again.",
        500
      )
    }
    throw err
  }
}

/**
 * Turns a "kubernetes" environment row into a connection target, decrypting
 * its credentials. The result holds the token/private key in memory: never
 * log it or send it to the browser.
 */
export function kubeTarget(env: KubeEnvironmentRow): KubeTarget {
  if (env.type !== "kubernetes") throw new KubeError("This is not a Kubernetes environment", 409)
  const c = decryptKubeCredentials(env)
  return {
    server: env.url,
    token: c.token ?? null,
    cert: c.cert ?? null,
    key: c.key ?? null,
    ca: c.ca ?? null,
    insecure: Boolean(env.kube_insecure),
  }
}

/** Which kinds of credentials are stored, for display (no secret material). */
export function credentialSummary(env: Pick<Environment, "type" | "kube_credentials">): string[] {
  if (env.type !== "kubernetes") return []
  try {
    const c = decryptKubeCredentials(env)
    const out: string[] = []
    if (c.token) out.push("token")
    if (c.cert && c.key) out.push("client certificate")
    if (c.ca) out.push("CA")
    return out
  } catch {
    return []
  }
}
