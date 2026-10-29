import "server-only"

import { jwtVerify, SignJWT } from "jose"

import { config, getSessionSecret } from "@/lib/server/config"

// Kept free of next/headers so proxy.ts can verify tokens too.

export const SESSION_COOKIE = "gantry_session"
export const ENV_COOKIE = "gantry_env"

export type SessionPayload = {
  uid: number
  role: "admin" | "user"
}

export async function signSession(payload: SessionPayload) {
  return new SignJWT({ role: payload.role })
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
    if (!Number.isInteger(uid) || (role !== "admin" && role !== "user")) return null
    return { uid, role }
  } catch {
    return null
  }
}
