import "server-only"

import crypto from "node:crypto"
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"
import type { Kysely } from "kysely"

import type { Database, Role } from "@/lib/server/db/schema"
import { changeRole } from "@/lib/server/users"

// OpenID Connect single sign-on (authorization code flow with PKCE, state
// and nonce). Configured with OIDC_* environment variables; disabled when
// they are missing. Users are linked by issuer + subject only: an existing
// local user is never matched by email or username, they link their account
// themselves from the Account page.

export type OidcConfig = {
  issuer: string
  clientId: string
  /** Absent for public clients (PKCE only). */
  clientSecret?: string
  redirectUri: string
  scopes: string[]
  /** Claim with the user's groups (string or string array). */
  groupsClaim: string
  /** Members of any of these groups become administrators; empty = SSO never changes roles. */
  adminGroups: string[]
  /** Claim used for the username of new users. */
  usernameClaim: string
  /** Create a standard user on the first login of an unknown identity. */
  autoCreate: boolean
}

type Env = Record<string, string | undefined>

const value = (env: Env, name: string) => {
  const v = env[name]?.trim()
  return v ? v : undefined
}
const list = (v: string | undefined) =>
  (v ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)

/** Path of the callback route (app/auth/oidc/callback/route.ts). */
export const OIDC_CALLBACK_PATH = "/auth/oidc/callback"

/**
 * Reads the OIDC settings. Null when SSO isn't configured; throws when it is
 * configured incompletely, so a typo doesn't silently turn SSO off.
 */
export function oidcConfigFromEnv(env: Env = process.env): OidcConfig | null {
  const issuer = value(env, "OIDC_ISSUER")
  const clientId = value(env, "OIDC_CLIENT_ID")
  if (!issuer && !clientId) return null
  if (!issuer || !clientId) throw new Error("OIDC_ISSUER and OIDC_CLIENT_ID must both be set to enable single sign-on")
  const base = value(env, "GANTRY_URL")
  const redirectUri = value(env, "OIDC_REDIRECT_URL") ?? (base ? `${base.replace(/\/+$/, "")}${OIDC_CALLBACK_PATH}` : undefined)
  if (!redirectUri) throw new Error("Set GANTRY_URL (or OIDC_REDIRECT_URL) so the OIDC callback URL is known")
  let parsed: URL
  try {
    parsed = new URL(redirectUri)
  } catch {
    throw new Error("OIDC_REDIRECT_URL / GANTRY_URL must be an absolute http(s) URL")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("OIDC_REDIRECT_URL / GANTRY_URL must be an absolute http(s) URL")
  }
  const scopes = list(value(env, "OIDC_SCOPES") ?? "openid profile email")
  if (!scopes.includes("openid")) scopes.unshift("openid")
  return {
    issuer: issuer.replace(/\/+$/, ""),
    clientId,
    clientSecret: value(env, "OIDC_CLIENT_SECRET"),
    redirectUri,
    scopes,
    groupsClaim: value(env, "OIDC_GROUPS_CLAIM") ?? "groups",
    adminGroups: list(value(env, "OIDC_ADMIN_GROUPS")),
    usernameClaim: value(env, "OIDC_USERNAME_CLAIM") ?? "preferred_username",
    autoCreate: value(env, "OIDC_AUTO_CREATE") === "true",
  }
}

let cachedConfig: { config: OidcConfig | null } | undefined

/** Process-wide OIDC settings (null = SSO off). A misconfiguration is logged once and disables SSO. */
export function getOidcConfig(): OidcConfig | null {
  if (!cachedConfig) {
    try {
      cachedConfig = { config: oidcConfigFromEnv() }
    } catch (err) {
      console.error(`[gantry] single sign-on disabled: ${(err as Error).message}`)
      cachedConfig = { config: null }
    }
  }
  return cachedConfig.config
}

/**
 * PASSWORD_LOGIN=admins keeps the password form for local administrators only
 * (break-glass access when the identity provider is down); everyone else
 * must use SSO. Ignored while SSO isn't configured.
 */
export function passwordLoginAllowed(role: Role, env: Env = process.env): boolean {
  if (value(env, "PASSWORD_LOGIN") !== "admins") return true
  if (!getOidcConfigFor(env)) return true
  return role === "admin"
}

function getOidcConfigFor(env: Env) {
  return env === process.env ? getOidcConfig() : oidcConfigFromEnv(env)
}

// ----------------------------------------------------------------- Helpers

export function randomUrlToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url")
}

/** PKCE (RFC 7636) S256 pair. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomUrlToken(32)
  return { verifier, challenge: pkceChallenge(verifier) }
}

export function pkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url")
}

/** Constant-time string comparison (different lengths are simply unequal). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

export type Discovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  userinfo_endpoint?: string
  id_token_signing_alg_values_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
}

const FETCH_TIMEOUT_MS = 10_000
const DISCOVERY_TTL_MS = 60 * 60_000
const discoveryCache = new Map<string, { doc: Discovery; at: number }>()

export class OidcError extends Error {}

/** The provider's metadata from /.well-known/openid-configuration (cached for an hour). */
export async function discover(issuer: string, { fresh = false } = {}): Promise<Discovery> {
  const hit = discoveryCache.get(issuer)
  if (hit && !fresh && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc
  let doc: Discovery
  try {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    })
    if (!res.ok) throw new OidcError(`discovery returned HTTP ${res.status}`)
    doc = (await res.json()) as Discovery
  } catch (err) {
    throw err instanceof OidcError ? err : new OidcError(`discovery failed: ${(err as Error).message}`)
  }
  // OpenID Connect Discovery 1.0, section 4.3: the issuer must match exactly.
  if (doc.issuer?.replace(/\/+$/, "") !== issuer) throw new OidcError("discovery document is for a different issuer")
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof doc[k] !== "string" || !/^https?:\/\//.test(doc[k])) throw new OidcError(`discovery document has no ${k}`)
  }
  discoveryCache.set(issuer, { doc, at: Date.now() })
  return doc
}

export function authorizationUrl(
  doc: Discovery,
  config: OidcConfig,
  params: { state: string; nonce: string; challenge: string }
): string {
  const url = new URL(doc.authorization_endpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", config.clientId)
  url.searchParams.set("redirect_uri", config.redirectUri)
  url.searchParams.set("scope", config.scopes.join(" "))
  url.searchParams.set("state", params.state)
  url.searchParams.set("nonce", params.nonce)
  url.searchParams.set("code_challenge", params.challenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.toString()
}

/** Exchanges the authorization code for tokens; returns the ID token (and access token for userinfo). */
export async function exchangeCode(
  doc: Discovery,
  config: OidcConfig,
  code: string,
  verifier: string
): Promise<{ idToken: string; accessToken?: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  })
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  }
  const methods = doc.token_endpoint_auth_methods_supported ?? ["client_secret_basic"]
  if (!config.clientSecret) {
    body.set("client_id", config.clientId)
  } else if (!methods.includes("client_secret_basic") && methods.includes("client_secret_post")) {
    body.set("client_id", config.clientId)
    body.set("client_secret", config.clientSecret)
  } else {
    // RFC 6749 section 2.3.1: both parts form-encoded before base64.
    const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, "+")
    headers.Authorization = `Basic ${Buffer.from(`${enc(config.clientId)}:${enc(config.clientSecret)}`).toString("base64")}`
  }
  let res: Response
  try {
    res = await fetch(doc.token_endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: "no-store" })
  } catch (err) {
    throw new OidcError(`token request failed: ${(err as Error).message}`)
  }
  const json = (await res.json().catch(() => ({}))) as { id_token?: unknown; access_token?: unknown; error?: unknown }
  if (!res.ok) throw new OidcError(`token endpoint returned HTTP ${res.status}${typeof json.error === "string" ? ` (${json.error})` : ""}`)
  if (typeof json.id_token !== "string") throw new OidcError("token response has no id_token")
  return { idToken: json.id_token, accessToken: typeof json.access_token === "string" ? json.access_token : undefined }
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

/**
 * Validates the ID token's signature against the provider's JWKS and its
 * iss, aud, exp and nonce (plus azp when there are several audiences).
 * HS* algorithms are refused: they would make the client secret a signing key.
 */
export async function validateIdToken(idToken: string, doc: Discovery, config: OidcConfig, nonce: string): Promise<JWTPayload> {
  let jwks = jwksCache.get(doc.jwks_uri)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(doc.jwks_uri), { timeoutDuration: FETCH_TIMEOUT_MS })
    jwksCache.set(doc.jwks_uri, jwks)
  }
  const allowed = (doc.id_token_signing_alg_values_supported ?? ["RS256"]).filter((a) => a !== "none" && !a.startsWith("HS"))
  let payload: JWTPayload
  try {
    ;({ payload } = await jwtVerify(idToken, jwks, {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: allowed.length ? allowed : ["RS256"],
      clockTolerance: 60,
    }))
  } catch (err) {
    throw new OidcError(`invalid ID token: ${(err as Error).message}`)
  }
  if (typeof payload.nonce !== "string" || !safeEqual(payload.nonce, nonce)) throw new OidcError("ID token nonce mismatch")
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) {
    throw new OidcError("ID token azp mismatch")
  }
  if (typeof payload.sub !== "string" || !payload.sub) throw new OidcError("ID token has no subject")
  return payload
}

/** Userinfo claims (OIDC Core 5.3), only used when it is for the same subject. */
export async function fetchUserinfo(doc: Discovery, accessToken: string, subject: string): Promise<Record<string, unknown>> {
  if (!doc.userinfo_endpoint) return {}
  try {
    const res = await fetch(doc.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    })
    if (!res.ok) return {}
    const claims = (await res.json()) as Record<string, unknown>
    return claims.sub === subject ? claims : {}
  } catch {
    return {}
  }
}

export type OidcIdentity = {
  issuer: string
  subject: string
  /** Proposed username for a new account. */
  username: string
  /** true/false when OIDC_ADMIN_GROUPS is set, null when SSO doesn't manage roles. */
  admin: boolean | null
}

/** Groups from a claim that may be a string, a list or missing. */
export function groupsOf(claims: Record<string, unknown>, claim: string): string[] {
  const v = claims[claim]
  if (typeof v === "string") return [v]
  if (Array.isArray(v)) return v.filter((g): g is string => typeof g === "string")
  return []
}

/** A valid Gantry username (3-64 of [a-zA-Z0-9_.-]) from whatever the provider sent. */
export function usernameFromClaims(claims: Record<string, unknown>, claim: string, subject: string): string {
  const pick = [claims[claim], typeof claims.email === "string" ? claims.email.split("@")[0] : undefined, claims.name]
  for (const raw of pick) {
    if (typeof raw !== "string") continue
    const clean = raw
      .normalize("NFKD")
      // Drop accents (combining marks) so "Jörg" becomes "Jorg".
      .replace(/\p{M}+/gu, "")
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 56)
    if (clean.length >= 3) return clean
  }
  return `sso-${crypto.createHash("sha256").update(subject).digest("hex").slice(0, 8)}`
}

export function identityFromClaims(claims: Record<string, unknown>, config: OidcConfig): OidcIdentity {
  const subject = String(claims.sub)
  const groups = groupsOf(claims, config.groupsClaim)
  return {
    issuer: config.issuer,
    subject,
    username: usernameFromClaims(claims, config.usernameClaim, subject),
    admin: config.adminGroups.length ? groups.some((g) => config.adminGroups.includes(g)) : null,
  }
}

// ------------------------------------------------------------------ Users

/** Password hash of SSO-only accounts: verifyPassword() never accepts it. */
export const NO_PASSWORD = "!sso"

export type OidcLogin =
  | { ok: true; user: { id: number; username: string; role: Role }; created: boolean; roleChanged: boolean }
  | { ok: false; reason: "not_linked" }

/**
 * The Gantry user for an SSO identity. Linked users keep their account; with
 * OIDC_ADMIN_GROUPS their role follows the group claim (the last administrator
 * is never demoted). Unknown identities get a new standard user (or admin, by
 * group) when auto-create is on, with a unique username and no password.
 */
export async function resolveOidcUser(db: Kysely<Database>, identity: OidcIdentity, autoCreate: boolean): Promise<OidcLogin> {
  const existing = await db
    .selectFrom("users")
    .select(["id", "username", "role"])
    .where("oidc_issuer", "=", identity.issuer)
    .where("oidc_subject", "=", identity.subject)
    .executeTakeFirst()

  if (existing) {
    let role = existing.role
    if (identity.admin !== null) {
      const wanted: Role = identity.admin ? "admin" : "user"
      if (wanted !== role && (await changeRole(db, existing.id, wanted)) === "ok") role = wanted
    }
    return { ok: true, user: { ...existing, role }, created: false, roleChanged: role !== existing.role }
  }

  if (!autoCreate) return { ok: false, reason: "not_linked" }

  const role: Role = identity.admin ? "admin" : "user"
  for (let i = 1; i <= 50; i++) {
    const username = i === 1 ? identity.username : `${identity.username}-${i}`
    const taken = await db.selectFrom("users").select("id").where("username", "=", username).executeTakeFirst()
    if (taken) continue
    const res = await db
      .insertInto("users")
      .values({
        username,
        password_hash: NO_PASSWORD,
        role,
        created_at: new Date().toISOString(),
        oidc_issuer: identity.issuer,
        oidc_subject: identity.subject,
      })
      .executeTakeFirstOrThrow()
    return { ok: true, user: { id: Number(res.insertId), username, role }, created: true, roleChanged: false }
  }
  throw new OidcError("could not find a free username")
}

/** Links a signed-in user to an SSO identity. Fails if the identity belongs to someone else. */
export async function linkOidcIdentity(
  db: Kysely<Database>,
  userId: number,
  identity: Pick<OidcIdentity, "issuer" | "subject">
): Promise<"linked" | "taken"> {
  const owner = await db
    .selectFrom("users")
    .select("id")
    .where("oidc_issuer", "=", identity.issuer)
    .where("oidc_subject", "=", identity.subject)
    .executeTakeFirst()
  if (owner && owner.id !== userId) return "taken"
  await db
    .updateTable("users")
    .set({ oidc_issuer: identity.issuer, oidc_subject: identity.subject })
    .where("id", "=", userId)
    .execute()
  return "linked"
}
