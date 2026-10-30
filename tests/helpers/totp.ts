import crypto from "node:crypto"

/**
 * Independent TOTP (RFC 6238, SHA-1, 30 s, 6 digits) for the e2e tests: an
 * authenticator app's view of a base32 secret, written separately from
 * lib/server/auth/totp.ts so the two check each other.
 */
export function authenticatorCode(secret: string, atMs = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const ch of secret.replace(/[\s=]/g, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0")
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)))
  const mac = crypto.createHmac("sha1", key).update(counter).digest()
  const offset = mac[19] & 0xf
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0")
}
