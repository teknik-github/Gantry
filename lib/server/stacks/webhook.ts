import "server-only"

import crypto from "node:crypto"

// Verification and parsing of Git webhook deliveries (GitHub, GitLab,
// Gitea/Forgejo and a generic token). Pure apart from node:crypto, so the
// signature vectors are unit-tested.

export type WebhookProvider = "github" | "gitlab" | "gitea" | "generic"

export type Verification =
  | { ok: true; provider: WebhookProvider }
  | { ok: false; provider: WebhookProvider | null; reason: string }

export function hmacSha256Hex(secret: string, body: Uint8Array) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex")
}

/** Constant-time string comparison (digests first, so lengths don't leak either). */
export function safeEqual(a: string, b: string) {
  const da = crypto.createHash("sha256").update(a, "utf8").digest()
  const db = crypto.createHash("sha256").update(b, "utf8").digest()
  return crypto.timingSafeEqual(da, db) && a.length === b.length
}

/**
 * Checks a delivery against the stack's secret. The provider is recognised
 * by its header: Gitea/Forgejo (X-Gitea-Signature / X-Forgejo-Signature,
 * hex HMAC-SHA256 of the body), GitHub (X-Hub-Signature-256: sha256=<hex>),
 * GitLab (X-Gitlab-Token: the secret itself), otherwise a generic token in
 * X-Gantry-Token, `Authorization: Bearer` or `?token=`.
 */
export function verifyDelivery(headers: Headers, url: URL, body: Uint8Array, secret: string): Verification {
  const giteaSig = headers.get("x-gitea-signature") ?? headers.get("x-forgejo-signature")
  if (giteaSig) {
    return safeEqual(giteaSig.trim().toLowerCase(), hmacSha256Hex(secret, body))
      ? { ok: true, provider: "gitea" }
      : { ok: false, provider: "gitea", reason: "invalid signature" }
  }
  const githubSig = headers.get("x-hub-signature-256")
  if (githubSig) {
    return safeEqual(githubSig.trim().toLowerCase(), `sha256=${hmacSha256Hex(secret, body)}`)
      ? { ok: true, provider: "github" }
      : { ok: false, provider: "github", reason: "invalid signature" }
  }
  const gitlabToken = headers.get("x-gitlab-token")
  if (gitlabToken !== null) {
    return safeEqual(gitlabToken, secret)
      ? { ok: true, provider: "gitlab" }
      : { ok: false, provider: "gitlab", reason: "invalid token" }
  }
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1]
  const token = headers.get("x-gantry-token") ?? bearer ?? url.searchParams.get("token")
  if (token !== null && token !== undefined) {
    return safeEqual(token.trim(), secret)
      ? { ok: true, provider: "generic" }
      : { ok: false, provider: "generic", reason: "invalid token" }
  }
  return { ok: false, provider: null, reason: "no signature or token" }
}

export type Delivery =
  /** A push (or a generic trigger); `ref` null = no ref given (generic: deploy). */
  | { kind: "push"; ref: string | null; deleted: boolean; after: string | null }
  | { kind: "ping" }
  | { kind: "other"; event: string }

const ZERO_SHA = /^0+$/

/**
 * What a verified delivery asks for. Throws SyntaxError for an unreadable
 * body. GitHub may send form-encoded payloads (`payload=<json>`).
 */
export function parseDelivery(provider: WebhookProvider, headers: Headers, body: Uint8Array): Delivery {
  const event =
    provider === "github"
      ? headers.get("x-github-event")
      : provider === "gitlab"
        ? headers.get("x-gitlab-event")
        : provider === "gitea"
          ? (headers.get("x-gitea-event") ?? headers.get("x-forgejo-event"))
          : null

  if (provider === "github" && event === "ping") return { kind: "ping" }
  if (provider === "github" && event && event !== "push") return { kind: "other", event }
  if (provider === "gitlab" && event && event !== "Push Hook" && event !== "Tag Push Hook") return { kind: "other", event }
  if (provider === "gitea" && event && event !== "push") return { kind: "other", event }

  const text = Buffer.from(body).toString("utf8").trim()
  if (!text) {
    if (provider === "generic") return { kind: "push", ref: null, deleted: false, after: null }
    throw new SyntaxError("Empty payload")
  }
  let json: unknown
  if ((headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
    const payload = new URLSearchParams(text).get("payload")
    if (payload === null) {
      if (provider === "generic") return { kind: "push", ref: null, deleted: false, after: null }
      throw new SyntaxError("Missing payload")
    }
    json = JSON.parse(payload)
  } else {
    json = JSON.parse(text)
  }
  const data = (json && typeof json === "object" ? json : {}) as Record<string, unknown>
  const ref = typeof data.ref === "string" ? data.ref : null
  const after = typeof data.after === "string" ? data.after : null
  const deleted = data.deleted === true || (after !== null && ZERO_SHA.test(after))
  if (provider !== "generic" && !ref) throw new SyntaxError("The payload has no ref")
  return { kind: "push", ref, deleted, after }
}
