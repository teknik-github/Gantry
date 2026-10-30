import { describe, expect, it } from "vitest"

import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  normalizeRecoveryCode,
  otpauthUri,
  RECOVERY_CODE_COUNT,
  totpCode,
  totpStep,
  verifyTotp,
} from "@/lib/server/auth/totp"

// RFC 6238 appendix B: 8-digit codes, seeds of 20/32/64 ASCII bytes.
const SEEDS = {
  sha1: Buffer.from("12345678901234567890"),
  sha256: Buffer.from("12345678901234567890123456789012"),
  sha512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
}
const VECTORS: [number, string, string, string][] = [
  // time, SHA1, SHA256, SHA512
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
]

describe("TOTP (RFC 6238)", () => {
  it.each(VECTORS)("matches the test vectors at T=%i", (time, sha1, sha256, sha512) => {
    const step = totpStep(time * 1000)
    expect(hotp(SEEDS.sha1, step, { digits: 8 })).toBe(sha1)
    expect(hotp(SEEDS.sha256, step, { digits: 8, algorithm: "sha256" })).toBe(sha256)
    expect(hotp(SEEDS.sha512, step, { digits: 8, algorithm: "sha512" })).toBe(sha512)
  })

  it("matches RFC 4226 HOTP values (6 digits)", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]
    expected.forEach((code, counter) => expect(hotp(SEEDS.sha1, counter)).toBe(code))
  })

  it("round-trips base32 and generates 160-bit secrets", () => {
    expect(base32Encode(SEEDS.sha1)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").equals(SEEDS.sha1)).toBe(true)
    const secret = generateTotpSecret()
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    expect(base32Decode(secret)).toHaveLength(20)
    expect(generateTotpSecret()).not.toBe(secret)
    expect(() => base32Decode("not base32!")).toThrow()
  })

  it("accepts the current code and one step either side, nothing further", () => {
    const secret = base32Encode(SEEDS.sha1)
    const now = 1_700_000_000_000
    const step = totpStep(now)
    expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(step)
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(step - 1)
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now)).toBe(step + 1)
    expect(verifyTotp(secret, totpCode(secret, now - 60_000), now)).toBeNull()
    expect(verifyTotp(secret, totpCode(secret, now + 60_000), now)).toBeNull()
  })

  it("ignores spaces and rejects malformed codes", () => {
    const secret = base32Encode(SEEDS.sha1)
    const now = 1_700_000_000_000
    const code = totpCode(secret, now)
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(totpStep(now))
    for (const bad of ["", "12345", "1234567", "abcdef", "12345a"]) expect(verifyTotp(secret, bad, now)).toBeNull()
  })

  it("builds an otpauth:// URI authenticator apps understand", () => {
    const uri = new URL(otpauthUri("JBSWY3DPEHPK3PXP", "alice smith"))
    expect(uri.protocol).toBe("otpauth:")
    expect(uri.host).toBe("totp")
    expect(decodeURIComponent(uri.pathname)).toBe("/Gantry:alice smith")
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      issuer: "Gantry",
      algorithm: "SHA1",
      digits: "6",
      period: "30",
    })
  })
})

describe("recovery codes", () => {
  it("generates ten distinct, readable codes", () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT)
    expect(new Set(codes).size).toBe(codes.length)
    for (const c of codes) expect(c).toMatch(/^[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/)
  })

  it("hashes the normalized form, so case and separators don't matter", () => {
    const [code] = generateRecoveryCodes(1)
    const hash = hashRecoveryCode(code)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashRecoveryCode(code.toLowerCase())).toBe(hash)
    expect(hashRecoveryCode(code.replace("-", " "))).toBe(hash)
    expect(hash).not.toContain(code.replace("-", ""))
  })

  it("rejects things that can't be recovery codes", () => {
    expect(normalizeRecoveryCode("123456")).toBeNull()
    expect(normalizeRecoveryCode("ABCDE-FGHIJ-K")).toBeNull()
    expect(() => hashRecoveryCode("nope")).toThrow()
  })
})
