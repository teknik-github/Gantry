import "server-only"

import { stringify } from "yaml"

import type { KubeTarget } from "@/lib/server/kubernetes/client"

/**
 * Kubeconfig and secret handling for CLI tools (helm) that run against an
 * environment. The kubeconfig embeds the stored credentials, so it only
 * ever lives in a private temp dir for the duration of one command; the
 * redactor scrubs those credentials (and anything else secret) from what
 * the command prints before it is shown or kept.
 */

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

/** A kubeconfig with a single context for `target` (token and/or client certificate). */
export function buildKubeconfig(target: KubeTarget, namespace?: string | null): string {
  const cluster: Record<string, unknown> = { server: target.server }
  if (target.ca) cluster["certificate-authority-data"] = b64(target.ca)
  if (target.insecure) cluster["insecure-skip-tls-verify"] = true

  const user: Record<string, unknown> = {}
  if (target.token) user.token = target.token
  if (target.cert && target.key) {
    user["client-certificate-data"] = b64(target.cert)
    user["client-key-data"] = b64(target.key)
  }

  const context: Record<string, unknown> = { cluster: "gantry", user: "gantry" }
  if (namespace) context.namespace = namespace

  return stringify(
    {
      apiVersion: "v1",
      kind: "Config",
      clusters: [{ name: "gantry", cluster }],
      users: [{ name: "gantry", user }],
      contexts: [{ name: "gantry", context }],
      "current-context": "gantry",
      preferences: {},
    },
    { lineWidth: 0 }
  )
}

/**
 * Strings that must never appear in output: the token, the client key and
 * certificate (PEM and base64, as they appear in the kubeconfig), plus any
 * `extra` secrets (repository passwords, basic-auth headers, temp paths).
 */
export function secretsOf(target: Pick<KubeTarget, "token" | "key" | "cert">, extra: (string | null | undefined)[] = []): string[] {
  const out = new Set<string>()
  const add = (s: string | null | undefined) => {
    if (s && s.length >= 6) out.add(s)
  }
  add(target.token)
  for (const pem of [target.key, target.cert]) {
    if (!pem) continue
    add(pem.trim())
    add(b64(pem))
    // Line by line too: a tool may print part of a PEM block.
    for (const line of pem.split(/\r?\n/)) if (!line.startsWith("-----") && line.trim().length >= 16) add(line.trim())
  }
  for (const s of extra) add(s)
  // Longest first, so a secret containing another is replaced whole.
  return [...out].sort((a, b) => b.length - a.length)
}

const PRIVATE_KEY_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const AUTH_FIELD_RE = /("?(?:token|password|client-key-data|auth)"?[ \t]*[:=][ \t]*"?)[^\s",}]{6,}/gi

/**
 * Replaces the given secrets in `text` and, unless `exactOnly`, anything
 * that looks like a credential (private keys, Authorization values,
 * token/password fields).
 */
export function redactSecrets(text: string, secrets: string[], exactOnly = false): string {
  let out = text
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join("[redacted]")
  if (exactOnly) return out
  return out
    .replace(PRIVATE_KEY_RE, "[redacted private key]")
    .replace(BEARER_RE, "$1 [redacted]")
    .replace(AUTH_FIELD_RE, "$1[redacted]")
}

/**
 * Redacts a stream line by line: text is held until its line is complete
 * (or flushed at the end), so a secret split across two chunks is still
 * caught. Lines longer than `maxLine` are passed on in pieces.
 */
export function lineRedactor(secrets: string[], emit: (text: string) => void, maxLine = 64 * 1024) {
  let pending = ""
  return {
    push(chunk: string) {
      pending += chunk
      const nl = pending.lastIndexOf("\n")
      if (nl >= 0) {
        emit(redactSecrets(pending.slice(0, nl + 1), secrets))
        pending = pending.slice(nl + 1)
      }
      if (pending.length > maxLine) {
        emit(redactSecrets(pending, secrets))
        pending = ""
      }
    },
    flush() {
      if (pending) emit(redactSecrets(pending, secrets))
      pending = ""
    },
  }
}
