import "server-only"

import crypto from "node:crypto"

/**
 * Constant-time string comparison for secrets (session secrets, OIDC state
 * and nonce, webhook signatures, tokens). Both sides are hashed first, so
 * neither the content nor the length of the expected value leaks.
 */
export function safeEqual(a: string, b: string): boolean {
  const da = crypto.createHash("sha256").update(a, "utf8").digest()
  const db = crypto.createHash("sha256").update(b, "utf8").digest()
  return crypto.timingSafeEqual(da, db)
}
