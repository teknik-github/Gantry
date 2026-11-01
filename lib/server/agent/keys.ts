import "server-only"

import crypto from "node:crypto"

// Enrollment keys of agent environments: "gak_<environment id>_" + 32 random
// bytes (base64url). Only a SHA-256 hash is stored (256 bits of entropy make
// a slow hash pointless), compared in constant time. The id in the key lets
// Gantry find the environment without searching by hash.

export const AGENT_KEY_PREFIX = "gak_"
const KEY_RE = /^gak_([1-9][0-9]{0,9})_([A-Za-z0-9_-]{43})$/
const HASH_RE = /^[a-f0-9]{64}$/

export function generateAgentKey(environmentId: number): string {
  if (!Number.isSafeInteger(environmentId) || environmentId <= 0) throw new Error("Invalid environment id")
  return `${AGENT_KEY_PREFIX}${environmentId}_${crypto.randomBytes(32).toString("base64url")}`
}

/** The environment a key claims to belong to (format only), or null. */
export function parseAgentKey(key: string): { environmentId: number } | null {
  const m = KEY_RE.exec(key)
  if (!m) return null
  const environmentId = Number(m[1])
  return Number.isSafeInteger(environmentId) ? { environmentId } : null
}

export function hashAgentKey(key: string): string {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex")
}

// Compared against when the environment has no key, so a missing environment
// takes as long to refuse as a wrong key.
const DUMMY_HASH = hashAgentKey("gak_0_unused")

/** Whether `key` hashes to `storedHash`, in constant time. */
export function verifyAgentKey(key: string, storedHash: string | null | undefined): boolean {
  const presented = Buffer.from(hashAgentKey(key), "hex")
  const valid = typeof storedHash === "string" && HASH_RE.test(storedHash)
  const expected = Buffer.from(valid ? storedHash : DUMMY_HASH, "hex")
  return crypto.timingSafeEqual(presented, expected) && valid
}

/** "gak_12_AbCd…" for logs and the UI: never more than the first characters of the secret. */
export function maskAgentKey(key: string): string {
  const m = KEY_RE.exec(key)
  return m ? `${AGENT_KEY_PREFIX}${m[1]}_${m[2].slice(0, 4)}…` : "(malformed key)"
}

/** Constant-time equality of two strings (session secrets). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8")
  const y = Buffer.from(b, "utf8")
  if (x.length !== y.length) {
    crypto.timingSafeEqual(x, x)
    return false
  }
  return crypto.timingSafeEqual(x, y)
}
