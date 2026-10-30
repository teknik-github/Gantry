import "server-only"

import crypto from "node:crypto"
import { isMap, parseDocument } from "yaml"

import { namespaceSchema } from "@/lib/kubernetes/names"
import { KubeError, parseServerUrl } from "@/lib/server/kubernetes/client"
import type { KubeCredentials } from "@/lib/server/kubernetes/target"

/**
 * Validates what an administrator enters for a Kubernetes environment:
 * either the API server, a bearer token and the CA, or a kubeconfig.
 * Errors never echo secrets back.
 */

export type KubeConnection = {
  server: string
  credentials: KubeCredentials
  insecure: boolean
  namespace: string | null
}

export type ConnectionField = "kube_server" | "kube_token" | "kube_ca" | "kube_namespace" | "kubeconfig" | "kube_context"

export type ConnectionResult =
  | { connection: KubeConnection; context?: string; errors?: never }
  | { connection?: never; context?: never; errors: Partial<Record<ConnectionField, string[]>> }

export const MAX_KUBECONFIG_BYTES = 256 * 1024
const MAX_TOKEN_BYTES = 16 * 1024

const CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

function normalizePem(value: string) {
  return value.replace(/\r\n?/g, "\n").trim() + "\n"
}

/** A PEM CA bundle that parses, or an error message. */
export function checkCa(pem: string): { ca: string } | { error: string } {
  const ca = normalizePem(pem)
  const certs = ca.match(CERT_RE) ?? []
  if (!certs.length) return { error: "Not a PEM certificate (-----BEGIN CERTIFICATE-----)" }
  try {
    for (const c of certs) new crypto.X509Certificate(c)
  } catch {
    return { error: "The CA certificate could not be parsed" }
  }
  return { ca }
}

/** A client certificate and its unencrypted private key, or an error message. */
export function checkClientCert(certPem: string, keyPem: string): { cert: string; key: string } | { error: string } {
  const cert = normalizePem(certPem)
  const key = normalizePem(keyPem)
  let x509: crypto.X509Certificate
  try {
    x509 = new crypto.X509Certificate(cert)
  } catch {
    return { error: "The client certificate could not be parsed" }
  }
  if (/ENCRYPTED/.test(key)) return { error: "Encrypted private keys are not supported" }
  let keyObject: crypto.KeyObject
  try {
    keyObject = crypto.createPrivateKey(key)
  } catch {
    return { error: "The client key could not be parsed" }
  }
  if (!x509.checkPrivateKey(keyObject)) return { error: "The client key does not belong to the client certificate" }
  return { cert, key }
}

function checkToken(value: string): { token: string } | { error: string } {
  const token = value.trim()
  if (!token) return { error: "Paste the service account token" }
  if (token.length > MAX_TOKEN_BYTES) return { error: "The token is too long" }
  if (!/^[\x21-\x7e]+$/.test(token)) return { error: "The token contains spaces or invalid characters" }
  return { token }
}

function checkNamespace(value: string | null | undefined): { namespace: string | null } | { error: string } {
  if (!value?.trim()) return { namespace: null }
  const parsed = namespaceSchema.safeParse(value)
  return parsed.success ? { namespace: parsed.data } : { error: parsed.error.issues[0]?.message ?? "Invalid namespace" }
}

function checkServer(value: string): { server: string } | { error: string } {
  if (!value.trim()) return { error: "The API server address is required" }
  try {
    const url = parseServerUrl(value)
    const server = url.toString().replace(/\/+$/, "")
    if (server.length > 255) return { error: "The address is too long" }
    return { server }
  } catch (err) {
    return { error: (err as KubeError).message }
  }
}

/** API server + bearer token (+ CA) entered field by field. */
export function parseTokenConnection(input: {
  server: string
  token: string
  ca: string
  insecure: boolean
  namespace?: string | null
}): ConnectionResult {
  const errors: Partial<Record<ConnectionField, string[]>> = {}
  const server = checkServer(input.server)
  if ("error" in server) errors.kube_server = [server.error]
  const token = checkToken(input.token)
  if ("error" in token) errors.kube_token = [token.error]
  let ca: string | undefined
  if (input.ca.trim()) {
    const res = checkCa(input.ca)
    if ("error" in res) errors.kube_ca = [res.error]
    else ca = res.ca
  }
  const namespace = checkNamespace(input.namespace)
  if ("error" in namespace) errors.kube_namespace = [namespace.error]

  if (Object.keys(errors).length || "error" in server || "error" in token || "error" in namespace) return { errors }
  return {
    connection: {
      server: server.server,
      credentials: { token: token.token, ...(ca ? { ca } : {}) },
      insecure: input.insecure,
      namespace: namespace.namespace,
    },
  }
}

type Named<T> = { name?: unknown; [key: string]: unknown } & Partial<T>

function findNamed(list: unknown, name: string, field: string): Record<string, unknown> | null {
  if (!Array.isArray(list)) return null
  const entry = (list as Named<object>[]).find((e) => e && typeof e === "object" && e.name === name)
  const value = entry?.[field]
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function decodeData(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const text = Buffer.from(value.trim(), "base64").toString("utf8")
  return text.includes("-----BEGIN") ? text : null
}

/**
 * Reads the API server and credentials from a kubeconfig: `context` (or
 * current-context) → cluster (server, certificate-authority-data,
 * insecure-skip-tls-verify) and user (token or client-certificate-data +
 * client-key-data). Credential plugins (exec, auth-provider) and file
 * references can't be used from a server, so they are rejected.
 */
export function parseKubeconfig(text: string, contextName?: string | null, namespaceOverride?: string | null): ConnectionResult {
  const fail = (message: string, field: ConnectionField = "kubeconfig"): ConnectionResult => ({ errors: { [field]: [message] } })
  if (!text.trim()) return fail("Paste a kubeconfig")
  if (Buffer.byteLength(text) > MAX_KUBECONFIG_BYTES) return fail("The kubeconfig is too large")

  const doc = parseDocument(text, { uniqueKeys: false })
  if (doc.errors.length) return fail(`Invalid YAML: ${doc.errors[0].message.split("\n")[0]}`)
  if (!isMap(doc.contents)) return fail("Not a kubeconfig (expected a YAML mapping with clusters, users and contexts)")
  const config = doc.toJS({ maxAliasCount: 20 }) as Record<string, unknown>
  if (!Array.isArray(config.clusters) || !Array.isArray(config.contexts) || !Array.isArray(config.users)) {
    return fail("Not a kubeconfig: clusters, users and contexts are required")
  }

  const name = contextName?.trim() || (typeof config["current-context"] === "string" ? config["current-context"] : "")
  if (!name) return fail("The kubeconfig has no current-context; enter the context to use", "kube_context")
  const context = findNamed(config.contexts, name, "context")
  if (!context) return fail(`Context "${name}" is not in the kubeconfig`, contextName?.trim() ? "kube_context" : "kubeconfig")

  const cluster = typeof context.cluster === "string" ? findNamed(config.clusters, context.cluster, "cluster") : null
  if (!cluster) return fail(`Cluster "${String(context.cluster)}" of context "${name}" is missing`)
  const user = typeof context.user === "string" ? findNamed(config.users, context.user, "user") : null
  if (!user) return fail(`User "${String(context.user)}" of context "${name}" is missing`)

  if (user.exec || user["auth-provider"]) {
    return fail(
      "This kubeconfig uses a credential plugin (exec/auth-provider, e.g. aws, gcloud, kubelogin), which Gantry can't run. Use a service account token instead."
    )
  }
  if (user.username || user.password) return fail("Basic authentication (username/password) is not supported. Use a token.")
  for (const key of ["tokenFile", "client-certificate", "client-key"]) {
    if (user[key]) return fail(`The user references a file (${key}). Embed it: kubectl config view --raw --minify --flatten`)
  }
  if (cluster["certificate-authority"]) {
    return fail("The cluster references a CA file. Embed it: kubectl config view --raw --minify --flatten")
  }
  for (const key of ["proxy-url", "tls-server-name"]) {
    if (cluster[key]) return fail(`${key} is not supported`)
  }

  const server = checkServer(typeof cluster.server === "string" ? cluster.server : "")
  if ("error" in server) return fail(`Cluster server: ${server.error}`)

  const credentials: KubeCredentials = {}
  if (cluster["certificate-authority-data"] !== undefined) {
    const pem = decodeData(cluster["certificate-authority-data"])
    const res = pem ? checkCa(pem) : { error: "invalid base64 PEM" }
    if ("error" in res) return fail(`certificate-authority-data: ${res.error}`)
    credentials.ca = res.ca
  }

  if (user.token !== undefined) {
    const res = checkToken(typeof user.token === "string" ? user.token : "")
    if ("error" in res) return fail(`User token: ${res.error}`)
    credentials.token = res.token
  }
  if (user["client-certificate-data"] !== undefined || user["client-key-data"] !== undefined) {
    const cert = decodeData(user["client-certificate-data"])
    const key = decodeData(user["client-key-data"])
    if (!cert || !key) return fail("client-certificate-data and client-key-data must both be base64 PEM")
    const res = checkClientCert(cert, key)
    if ("error" in res) return fail(res.error)
    credentials.cert = res.cert
    credentials.key = res.key
  }
  if (!credentials.token && !credentials.cert) {
    return fail(`User "${String(context.user)}" has no token or client certificate`)
  }

  const namespace = checkNamespace(namespaceOverride?.trim() || (typeof context.namespace === "string" ? context.namespace : null))
  if ("error" in namespace) return fail(namespace.error, "kube_namespace")

  return {
    context: name,
    connection: {
      server: server.server,
      credentials,
      insecure: cluster["insecure-skip-tls-verify"] === true,
      namespace: namespace.namespace,
    },
  }
}
