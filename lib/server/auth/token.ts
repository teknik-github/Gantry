import "server-only"

import crypto from "node:crypto"

import { jwtVerify, SignJWT } from "jose"

import { config, getSessionSecret } from "@/lib/server/config"

// Kept free of next/headers so proxy.ts can verify tokens too.

export const SESSION_COOKIE = "gantry_session"
export const ENV_COOKIE = "gantry_env"

/**
 * Request header proxy.ts sets on /api/* requests that carry an API token
 * (and strips from every other request). Its value is derived from the
 * secret, so a client can't add it to authenticate a page or Server Action
 * with a token even if the stripping were bypassed.
 */
export const API_AUTH_HEADER = "x-gantry-api-auth"

let apiMarker: string | undefined
export function apiAuthMarker(): string {
  apiMarker ??= crypto.createHmac("sha256", getSessionSecret()).update("gantry:api-bearer:v1").digest("base64url")
  return apiMarker
}

export type SessionPayload = {
  uid: number
  role: "admin" | "user"
  /** users.session_version when the session was created; the DAL rejects older ones. */
  ver: number
}

export async function signSession(payload: SessionPayload) {
  return new SignJWT({ role: payload.role, ver: payload.ver })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(String(payload.uid))
    .setIssuedAt()
    .setIssuer("gantry")
    .setExpirationTime(`${config.sessionTtlHours}h`)
    .sign(getSessionSecret())
}

export async function verifySession(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getSessionSecret(), {
      issuer: "gantry",
      algorithms: ["HS256"],
    })
    const uid = Number(payload.sub)
    const role = payload.role
    // Sessions from before session versions count as version 0.
    const ver = payload.ver ?? 0
    if (!Number.isInteger(uid) || (role !== "admin" && role !== "user") || !Number.isInteger(ver)) return null
    return { uid, role, ver: ver as number }
  } catch {
    return null
  }
}
