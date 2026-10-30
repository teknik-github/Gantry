import "server-only"

import crypto from "node:crypto"

// TOTP (RFC 6238) on HOTP (RFC 4226) with the parameters every authenticator
// app understands: HMAC-SHA-1, 30 second steps, 6 digits. Pure functions;
// lib/server/auth/two-factor.ts stores secrets and enforces one use per step.

export const TOTP_STEP_SECONDS = 30
export const TOTP_DIGITS = 6
/** Steps accepted before/after the current one, for clock drift. */
export const TOTP_WINDOW = 1
/** 160-bit secrets, the size RFC 4226 recommends for SHA-1. */
const SECRET_BYTES = 20

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function base32Encode(buf: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** Decodes RFC 4648 base32 (case-insensitive, spaces and padding ignored). Throws on other characters. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, "").toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch)
    if (idx < 0) throw new Error("Invalid base32")
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(SECRET_BYTES))
}

/** HOTP value for a counter (RFC 4226 section 5.3), zero-padded. */
export function hotp(
  key: Uint8Array,
  counter: number,
  { digits = TOTP_DIGITS, algorithm = "sha1" }: { digits?: number; algorithm?: "sha1" | "sha256" | "sha512" } = {}
): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = crypto.createHmac(algorithm, key).update(msg).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(bin).padStart(digits, "0")
}

/** Time step for a moment (ms since epoch). */
export function totpStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS)
}

/** The code an authenticator shows at `nowMs` for a base32 secret. */
export function totpCode(secret: string, nowMs: number = Date.now()): string {
  return hotp(base32Decode(secret), totpStep(nowMs))
}

/**
 * The time step `code` belongs to (current ±TOTP_WINDOW), or null. Every
 * candidate is compared in constant time, and all of them are checked so the
 * timing doesn't reveal which step matched. The caller must refuse steps that
 * were already used (two-factor.ts).
 */
export function verifyTotp(secret: string, code: string, nowMs: number = Date.now()): number | null {
  const normalized = code.replace(/\s/g, "")
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) return null
  const key = base32Decode(secret)
  const given = Buffer.from(normalized)
  const current = totpStep(nowMs)
  let matched: number | null = null
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, step)), given) && matched === null) matched = step
  }
  return matched
}

/**
 * otpauth:// URI for authenticator apps (Key Uri Format). The issuer is both
 * the label prefix and a parameter, as Google Authenticator expects.
 */
export function otpauthUri(secret: string, account: string, issuer = "Gantry"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params}`
}

// ------------------------------------------------------------ Recovery codes

export const RECOVERY_CODE_COUNT = 10
// Crockford-style alphabet without look-alikes (0/O, 1/I/L, U).
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"

/**
 * Ten one-time codes like "K7Q2M-9XPRT" (10 characters from a 29-letter
 * alphabet, ~48 bits each). They are high-entropy and single-use, so an
 * unsalted SHA-256 is enough to store them.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    let s = ""
    for (let i = 0; i < 10; i++) s += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]
    return `${s.slice(0, 5)}-${s.slice(5)}`
  })
}

/** Canonical form: upper case, no separators or spaces. Null if it can't be a recovery code. */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.replace(/[\s-]/g, "").toUpperCase()
  return /^[0-9A-Z]{10}$/.test(s) ? s : null
}

export function hashRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code)
  if (!normalized) throw new Error("Invalid recovery code")
  return crypto.createHash("sha256").update(`gantry-recovery:${normalized}`).digest("hex")
}
