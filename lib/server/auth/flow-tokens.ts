import "server-only"

import { jwtVerify, SignJWT } from "jose"

import { getSessionSecret } from "@/lib/server/config"

// Short-lived signed states of multi-step logins, kept in httpOnly cookies.
// They use their own issuers, so verifySession() (issuer "gantry") never
// accepts one as a session and they can't be swapped for each other.

/** Password accepted, second factor still missing. Not a session. */
export const PENDING_2FA_COOKIE = "gantry_2fa"
export const PENDING_2FA_TTL_SECONDS = 5 * 60
const PENDING_ISSUER = "gantry:2fa"

/** OIDC authorization request in flight (state, nonce, PKCE verifier). */
export const OIDC_STATE_COOKIE = "gantry_oidc"
export const OIDC_STATE_TTL_SECONDS = 10 * 60
const OIDC_ISSUER = "gantry:oidc"

export type Pending2fa = { uid: number; next: string }

export async function signPending2fa(p: Pending2fa) {
  return new SignJWT({ next: p.next })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(p.uid))
    .setIssuer(PENDING_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${PENDING_2FA_TTL_SECONDS}s`)
    .sign(getSessionSecret())
}

export async function verifyPending2fa(token: string | undefined): Promise<Pending2fa | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getSessionSecret(), { issuer: PENDING_ISSUER, algorithms: ["HS256"] })
    const uid = Number(payload.sub)
    if (!Number.isInteger(uid) || typeof payload.next !== "string") return null
    return { uid, next: payload.next }
  } catch {
    return null
  }
}

export type OidcState = {
  state: string
  nonce: string
  verifier: string
  next: string
  /** Set when a signed-in user links their account instead of signing in. */
  linkUid?: number
}

export async function signOidcState(s: OidcState) {
  return new SignJWT({ ...s })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(OIDC_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${OIDC_STATE_TTL_SECONDS}s`)
    .sign(getSessionSecret())
}

export async function verifyOidcState(token: string | undefined): Promise<OidcState | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getSessionSecret(), { issuer: OIDC_ISSUER, algorithms: ["HS256"] })
    const { state, nonce, verifier, next, linkUid } = payload
    if (typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string" || typeof next !== "string") {
      return null
    }
    return { state, nonce, verifier, next, linkUid: typeof linkUid === "number" ? linkUid : undefined }
  } catch {
    return null
  }
}

/**
 * Device cookie (OWASP "device cookies"): set after a complete login and
 * naming the user. Failed logins from a browser that holds a valid one for
 * the account count against that device instead of the account, so someone
 * hammering the account from elsewhere can't lock its owner out.
 */
export const DEVICE_COOKIE = "gantry_device"
export const DEVICE_TTL_SECONDS = 180 * 24 * 60 * 60
const DEVICE_ISSUER = "gantry:device"

export async function signDevice(uid: number) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(uid))
    .setIssuer(DEVICE_ISSUER)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${DEVICE_TTL_SECONDS}s`)
    .sign(getSessionSecret())
}

/** The user id and device id of a valid device cookie, or null. */
export async function verifyDevice(token: string | undefined): Promise<{ uid: number; id: string } | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getSessionSecret(), { issuer: DEVICE_ISSUER, algorithms: ["HS256"] })
    const uid = Number(payload.sub)
    if (!Number.isInteger(uid) || typeof payload.jti !== "string") return null
    return { uid, id: payload.jti }
  } catch {
    return null
  }
}
