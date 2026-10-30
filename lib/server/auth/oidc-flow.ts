import "server-only"

import { cookies } from "next/headers"

import { safeNext } from "@/lib/safe-redirect"
import { audit } from "@/lib/server/audit"
import { OIDC_STATE_COOKIE, OIDC_STATE_TTL_SECONDS, signOidcState, verifyOidcState } from "@/lib/server/auth/flow-tokens"
import {
  authorizationUrl,
  discover,
  exchangeCode,
  fetchUserinfo,
  generatePkce,
  getOidcConfig,
  identityFromClaims,
  linkOidcIdentity,
  OidcError,
  randomUrlToken,
  resolveOidcUser,
  safeEqual,
  validateIdToken,
  type OidcConfig,
} from "@/lib/server/auth/oidc"
import { setAuthCookie, signIn } from "@/lib/server/auth/session"
import { getDb } from "@/lib/server/db"

// The request side of single sign-on (cookies, sessions, audit). Used by
// app/auth/oidc/* and the Account page's "Link" button.

const secureFor = (config: OidcConfig) => new URL(config.redirectUri).protocol === "https:"

/**
 * Starts an authorization request: stores state, nonce and the PKCE verifier
 * in a short-lived signed cookie and returns the provider URL to go to.
 */
export async function beginOidc(opts: { next?: unknown; linkUid?: number }): Promise<string> {
  const config = getOidcConfig()
  if (!config) throw new OidcError("single sign-on is not configured")
  const doc = await discover(config.issuer)
  const { verifier, challenge } = generatePkce()
  const state = randomUrlToken()
  const nonce = randomUrlToken()
  const cookie = await signOidcState({ state, nonce, verifier, next: safeNext(opts.next), linkUid: opts.linkUid })
  await setAuthCookie(OIDC_STATE_COOKIE, cookie, OIDC_STATE_TTL_SECONDS, secureFor(config))
  return authorizationUrl(doc, config, { state, nonce, challenge })
}

export type OidcOutcome =
  | { kind: "signed-in"; next: string }
  | { kind: "linked" }
  | { kind: "error"; reason: "not_linked" | "taken" | "failed" | "denied" | "expired"; link: boolean }

/**
 * Handles the provider's redirect: checks state against the cookie (one
 * use), exchanges the code with the PKCE verifier, validates the ID token
 * (signature via JWKS, iss, aud, exp, nonce) and signs in or links the user.
 * Second-factor prompts are skipped: the identity provider owns MFA for SSO.
 */
export async function completeOidc(params: URLSearchParams, currentUserId: number | null): Promise<OidcOutcome> {
  const jar = await cookies()
  const pending = await verifyOidcState(jar.get(OIDC_STATE_COOKIE)?.value)
  jar.delete(OIDC_STATE_COOKIE)
  const link = pending?.linkUid !== undefined
  const config = getOidcConfig()
  if (!pending || !config) return { kind: "error", reason: "expired", link }
  const state = params.get("state") ?? ""
  if (!safeEqual(state, pending.state)) return { kind: "error", reason: "expired", link }
  if (params.get("error")) return { kind: "error", reason: "denied", link }
  const code = params.get("code")
  if (!code) return { kind: "error", reason: "failed", link }

  try {
    const doc = await discover(config.issuer)
    const tokens = await exchangeCode(doc, config, code, pending.verifier)
    let claims: Record<string, unknown> = await validateIdToken(tokens.idToken, doc, config, pending.nonce)
    // Some providers only put groups in userinfo.
    if (config.adminGroups.length && claims[config.groupsClaim] === undefined && tokens.accessToken) {
      claims = { ...(await fetchUserinfo(doc, tokens.accessToken, String(claims.sub))), ...claims }
    }
    const identity = identityFromClaims(claims, config)
    const db = await getDb()

    if (link) {
      // Only the user who started linking, still signed in, can finish it.
      if (currentUserId === null || currentUserId !== pending.linkUid) return { kind: "error", reason: "expired", link }
      const res = await linkOidcIdentity(db, currentUserId, identity)
      const user = await db.selectFrom("users").select(["id", "username", "role"]).where("id", "=", currentUserId).executeTakeFirst()
      if (res === "taken") {
        await audit(user ?? null, "account.sso_link_failed", "identity already linked to another user")
        return { kind: "error", reason: "taken", link }
      }
      await audit(user ?? null, "account.sso_link", config.issuer)
      return { kind: "linked" }
    }

    const result = await resolveOidcUser(db, identity, config.autoCreate)
    if (!result.ok) {
      await audit(null, "auth.sso_refused", `unlinked identity from ${config.issuer}`)
      return { kind: "error", reason: "not_linked", link }
    }
    const { user } = result
    if (result.created) await audit(user, "user.create", `${user.username} (SSO, ${user.role})`)
    if (result.roleChanged) await audit(user, "user.role", `${user.id}:${user.role} (SSO groups)`)
    await signIn(user.id, secureFor(config))
    await audit(user, "auth.login", `${user.username} (SSO)`)
    return { kind: "signed-in", next: pending.next }
  } catch (err) {
    // Never log tokens or the client secret; OidcError messages contain neither.
    console.error(`[gantry] single sign-on failed: ${err instanceof OidcError ? err.message : (err as Error).name}`)
    return { kind: "error", reason: "failed", link }
  }
}
