import { describe, expect, it } from "vitest"

import { decryptSecret, encryptSecret, SecretDecryptError } from "@/lib/server/crypto"

const KEY = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----\n"

describe("secret encryption (AES-256-GCM)", () => {
  it("round-trips a value", () => {
    const enc = encryptSecret(KEY, "ctx")
    expect(decryptSecret(enc, "ctx")).toBe(KEY)
  })

  it("does not contain the plaintext and uses a fresh IV each time", () => {
    const a = encryptSecret(KEY)
    const b = encryptSecret(KEY)
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]+$/)
    expect(a).not.toContain("PRIVATE KEY")
    expect(a).not.toBe(b)
  })

  it("round-trips empty and unicode strings", () => {
    expect(decryptSecret(encryptSecret(""))).toBe("")
    expect(decryptSecret(encryptSecret("ключ ✓"))).toBe("ключ ✓")
  })

  it("rejects tampered ciphertext", () => {
    const enc = encryptSecret(KEY)
    const raw = Buffer.from(enc.slice(3), "base64url")
    raw[raw.length - 1] ^= 1
    expect(() => decryptSecret(`v1.${raw.toString("base64url")}`)).toThrow(SecretDecryptError)
  })

  it("binds the context (a value can't be moved to another column)", () => {
    const enc = encryptSecret(KEY, "environment.tls_key")
    expect(() => decryptSecret(enc, "environment.tls_cert")).toThrow(SecretDecryptError)
  })

  it("fails with another session secret", () => {
    const enc = encryptSecret(KEY, "", new TextEncoder().encode("a".repeat(40)))
    expect(decryptSecret(enc, "", new TextEncoder().encode("a".repeat(40)))).toBe(KEY)
    expect(() => decryptSecret(enc, "", new TextEncoder().encode("b".repeat(40)))).toThrow(SecretDecryptError)
  })

  it("rejects malformed values without leaking details", () => {
    for (const bad of ["", "v1.", "v2.abcd", "plain text", "v1.AAAA"]) {
      expect(() => decryptSecret(bad)).toThrow(SecretDecryptError)
    }
  })
})
