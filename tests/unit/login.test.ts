import { SignJWT } from "jose"
import { describe, expect, it } from "vitest"

import { safeNext } from "@/lib/safe-redirect"
import { hashPassword, verifyPassword } from "@/lib/server/auth/password"
import { signSession, verifySession } from "@/lib/server/auth/token"
import { checkRateLimit, clearFailures, recordFailure } from "@/lib/server/rate-limit"

const secret = new TextEncoder().encode(process.env.GANTRY_SECRET)

describe("password hashing", () => {
  it("verifies the correct password", async () => {
    const hash = await hashPassword("correct horse battery")
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/)
    expect(await verifyPassword("correct horse battery", hash)).toBe(true)
  })

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery")
    expect(await verifyPassword("Correct horse battery", hash)).toBe(false)
    expect(await verifyPassword("", hash)).toBe(false)
  })

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")])
    expect(a).not.toBe(b)
  })

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("x", "")).toBe(false)
    expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false)
  })
})

describe("session token", () => {
  it("round-trips a valid session", async () => {
    const token = await signSession({ uid: 7, role: "admin" })
    expect(await verifySession(token)).toEqual({ uid: 7, role: "admin" })
  })

  it("returns null without a token", async () => {
    expect(await verifySession(undefined)).toBeNull()
    expect(await verifySession("")).toBeNull()
    expect(await verifySession("not-a-jwt")).toBeNull()
  })

  it("rejects a token whose payload was tampered with", async () => {
    const token = await signSession({ uid: 7, role: "user" })
    const [header, payload, sig] = token.split(".")
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString())
    const forged = Buffer.from(JSON.stringify({ ...claims, role: "admin" })).toString("base64url")
    expect(await verifySession(`${header}.${forged}.${sig}`)).toBeNull()
  })

  it("rejects a token signed with another secret", async () => {
    const token = await new SignJWT({ role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("1")
      .setIssuer("gantry")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("some-other-secret-some-other-secret-000"))
    expect(await verifySession(token)).toBeNull()
  })

  it("rejects an expired token", async () => {
    const token = await new SignJWT({ role: "admin" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("1")
      .setIssuer("gantry")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(secret)
    expect(await verifySession(token)).toBeNull()
  })

  it("rejects an unsigned (alg: none) token", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url")
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = `${enc({ alg: "none" })}.${enc({ sub: "1", role: "admin", iss: "gantry", exp })}.`
    expect(await verifySession(token)).toBeNull()
  })

  it("rejects tokens with an unknown role or non-numeric subject", async () => {
    const sign = (sub: string, role: string) =>
      new SignJWT({ role })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(sub)
        .setIssuer("gantry")
        .setExpirationTime("1h")
        .sign(secret)
    expect(await verifySession(await sign("1", "root"))).toBeNull()
    expect(await verifySession(await sign("abc", "admin"))).toBeNull()
  })
})

describe("post-login redirect (next=)", () => {
  it.each(["/dashboard", "/containers/abc?tab=logs", "/images"])("allows local path %s", (path) => {
    expect(safeNext(path)).toBe(path)
  })

  it.each([
    "//evil.com",
    "/\\evil.com",
    "https://evil.com",
    "javascript:alert(1)",
    "evil.com",
    "",
    null,
    undefined,
  ])("falls back to /dashboard for %s", (value) => {
    expect(safeNext(value)).toBe("/dashboard")
  })
})

describe("login rate limit", () => {
  it("blocks after the limit and resets on success", () => {
    const key = `test:${Math.random()}`
    const windowMs = 60_000
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(key, 5)).toBe(0)
      recordFailure(key, windowMs)
    }
    const wait = checkRateLimit(key, 5)
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThanOrEqual(60)

    clearFailures(key)
    expect(checkRateLimit(key, 5)).toBe(0)
  })

  it("tracks keys independently", () => {
    const a = `a:${Math.random()}`
    const b = `b:${Math.random()}`
    for (let i = 0; i < 5; i++) recordFailure(a, 60_000)
    expect(checkRateLimit(a, 5)).toBeGreaterThan(0)
    expect(checkRateLimit(b, 5)).toBe(0)
  })
})
