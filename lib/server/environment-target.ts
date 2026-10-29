import "server-only"

import crypto from "node:crypto"

import { decryptSecret, encryptSecret, SecretDecryptError } from "@/lib/server/crypto"
import type { Environment } from "@/lib/server/db/schema"
import { DockerError, type DockerTarget, type DockerTls } from "@/lib/server/docker/client"

/** The columns needed to connect to an environment. */
export type EnvironmentConnection = Pick<Environment, "type" | "url" | "tls_ca" | "tls_cert" | "tls_key">

// Bound as AAD so an encrypted value only decrypts in its own column.
const CONTEXT = { ca: "environment.tls_ca", cert: "environment.tls_cert", key: "environment.tls_key" } as const

export function hasTls(env: Pick<Environment, "type" | "tls_ca" | "tls_cert" | "tls_key">): boolean {
  return env.type === "tcp" && Boolean(env.tls_ca && env.tls_cert && env.tls_key)
}

/** Decrypts the stored TLS material of an environment. */
export function decryptTls(env: Pick<Environment, "type" | "tls_ca" | "tls_cert" | "tls_key">): DockerTls | null {
  if (!hasTls(env)) return null
  try {
    return {
      ca: decryptSecret(env.tls_ca!, CONTEXT.ca),
      cert: decryptSecret(env.tls_cert!, CONTEXT.cert),
      key: decryptSecret(env.tls_key!, CONTEXT.key),
    }
  } catch (err) {
    if (err instanceof SecretDecryptError) {
      throw new DockerError(
        "The stored TLS certificates can't be decrypted (was GANTRY_SECRET changed?). Edit the environment and paste them again.",
        500
      )
    }
    throw err
  }
}

/**
 * Turns an environment row into a Docker connection target, decrypting its
 * TLS material. Use this everywhere a DockerTarget is built from the
 * database; the result holds the private key in memory, so never log it or
 * send it to the browser.
 */
export function environmentTarget(env: EnvironmentConnection): DockerTarget {
  return { type: env.type, url: env.url, tls: decryptTls(env) }
}

/** Column values for storing (or clearing, with null) TLS material. */
export function encryptTls(tls: DockerTls | null): Pick<Environment, "tls_ca" | "tls_cert" | "tls_key"> {
  if (!tls) return { tls_ca: null, tls_cert: null, tls_key: null }
  return {
    tls_ca: encryptSecret(tls.ca, CONTEXT.ca),
    tls_cert: encryptSecret(tls.cert, CONTEXT.cert),
    tls_key: encryptSecret(tls.key, CONTEXT.key),
  }
}

const CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

function normalizePem(value: string) {
  return value.replace(/\r\n?/g, "\n").trim() + "\n"
}

/**
 * Validates pasted PEM material: the CA bundle and client certificate must
 * parse, the key must be an unencrypted private key matching the
 * certificate. Returns per-field errors (never echoing the key).
 */
export function parseTls(input: { ca: string; cert: string; key: string }):
  | { tls: DockerTls; errors?: never }
  | { tls?: never; errors: Partial<Record<"tls_ca" | "tls_cert" | "tls_key", string[]>> } {
  const errors: Partial<Record<"tls_ca" | "tls_cert" | "tls_key", string[]>> = {}
  const ca = normalizePem(input.ca)
  const cert = normalizePem(input.cert)
  const key = normalizePem(input.key)

  const caCerts = ca.match(CERT_RE) ?? []
  if (!input.ca.trim()) errors.tls_ca = ["Paste the CA certificate (ca.pem)"]
  else if (caCerts.length === 0) errors.tls_ca = ["Not a PEM certificate (-----BEGIN CERTIFICATE-----)"]
  else {
    try {
      for (const c of caCerts) new crypto.X509Certificate(c)
    } catch {
      errors.tls_ca = ["The CA certificate could not be parsed"]
    }
  }

  let x509: crypto.X509Certificate | null = null
  if (!input.cert.trim()) errors.tls_cert = ["Paste the client certificate (cert.pem)"]
  else if (!(cert.match(CERT_RE) ?? []).length) errors.tls_cert = ["Not a PEM certificate (-----BEGIN CERTIFICATE-----)"]
  else {
    try {
      x509 = new crypto.X509Certificate(cert)
    } catch {
      errors.tls_cert = ["The client certificate could not be parsed"]
    }
  }

  let keyObject: crypto.KeyObject | null = null
  if (!input.key.trim()) errors.tls_key = ["Paste the client private key (key.pem)"]
  else if (/ENCRYPTED/.test(key)) errors.tls_key = ["Encrypted private keys are not supported; remove the passphrase first"]
  else if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) errors.tls_key = ["Not a PEM private key (-----BEGIN … PRIVATE KEY-----)"]
  else {
    try {
      keyObject = crypto.createPrivateKey(key)
    } catch {
      errors.tls_key = ["The private key could not be parsed"]
    }
  }

  if (x509 && keyObject && !x509.checkPrivateKey(keyObject)) {
    errors.tls_key = ["This key does not belong to the client certificate"]
  }

  if (Object.keys(errors).length) return { errors }
  return { tls: { ca, cert, key } }
}
