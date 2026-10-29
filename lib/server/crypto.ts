import "server-only"

import crypto from "node:crypto"

import { getSessionSecret } from "@/lib/server/config"

/**
 * Symmetric encryption for secrets stored in the database (e.g. TLS private
 * keys of Docker environments). AES-256-GCM with a key derived via HKDF from
 * the session secret (GANTRY_SECRET or data/secret.key), so a leaked database
 * dump alone does not reveal them.
 *
 * Format: "v1." + base64url(iv[12] | tag[16] | ciphertext). The optional
 * `context` is bound as additional authenticated data, so a value copied to
 * another column/purpose fails to decrypt.
 *
 * Changing the session secret makes previously stored values undecryptable
 * (decryptSecret throws SecretDecryptError); they must be entered again.
 */

const VERSION = "v1"
const IV_BYTES = 12
const TAG_BYTES = 16

let cachedKey: { secret: Uint8Array; key: Buffer } | undefined

function deriveKey(secret: Uint8Array = getSessionSecret()): Buffer {
  if (cachedKey?.secret === secret) return cachedKey.key
  const key = Buffer.from(crypto.hkdfSync("sha256", secret, "gantry", "gantry:secret-box:v1", 32))
  cachedKey = { secret, key }
  return key
}

export class SecretDecryptError extends Error {
  constructor() {
    super("Stored secret could not be decrypted (was the Gantry secret changed?)")
    this.name = "SecretDecryptError"
  }
}

export function encryptSecret(plaintext: string, context = "", secret?: Uint8Array): string {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv)
  cipher.setAAD(Buffer.from(context, "utf8"))
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${VERSION}.${Buffer.concat([iv, tag, ciphertext]).toString("base64url")}`
}

export function decryptSecret(value: string, context = "", secret?: Uint8Array): string {
  const [version, payload] = value.split(".", 2)
  if (version !== VERSION || !payload) throw new SecretDecryptError()
  const raw = Buffer.from(payload, "base64url")
  if (raw.length < IV_BYTES + TAG_BYTES) throw new SecretDecryptError()
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), raw.subarray(0, IV_BYTES))
    decipher.setAAD(Buffer.from(context, "utf8"))
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8")
  } catch {
    throw new SecretDecryptError()
  }
}
