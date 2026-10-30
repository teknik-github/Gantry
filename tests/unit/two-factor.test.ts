import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { totpCode } from "@/lib/server/auth/totp"
import {
  beginEnrolment,
  confirmEnrolment,
  disableTwoFactor,
  regenerateRecoveryCodes,
  twoFactorStatus,
  verifySecondFactor,
} from "@/lib/server/auth/two-factor"
import { decryptSecret } from "@/lib/server/crypto"
import { openTestDb } from "../helpers/test-db"

describe("two-factor storage", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>
  let uid = 0
  let secret = ""
  let codes: string[] = []
  // A fixed clock so each check is in a known time step.
  const T0 = 1_800_000_000_000

  beforeAll(async () => {
    t = await openTestDb()
    uid = await t.addUser("alice")
  })
  afterAll(() => t?.cleanup())

  it("stores the secret encrypted and stays off until a code is confirmed", async () => {
    secret = (await beginEnrolment(t.db, uid))!
    expect(secret).toMatch(/^[A-Z2-7]{32}$/)
    const row = await t.db.selectFrom("users").select(["totp_secret", "totp_enabled"]).where("id", "=", uid).executeTakeFirstOrThrow()
    expect(row.totp_secret).not.toContain(secret)
    expect(decryptSecret(row.totp_secret!, `users.totp_secret:${uid}`)).toBe(secret)
    // Bound to the user: another user's context can't decrypt it.
    expect(() => decryptSecret(row.totp_secret!, `users.totp_secret:${uid + 1}`)).toThrow()
    expect(await twoFactorStatus(t.db, uid)).toEqual({ enabled: false, recoveryCodesLeft: 0 })
    expect(await verifySecondFactor(t.db, uid, totpCode(secret, T0), T0)).toEqual({ ok: false })
  })

  it("refuses a wrong code, then enables with the right one and returns recovery codes once", async () => {
    expect(await confirmEnrolment(t.db, uid, "000000", T0)).toBeNull()
    codes = (await confirmEnrolment(t.db, uid, totpCode(secret, T0), T0))!
    expect(codes).toHaveLength(10)
    expect(await twoFactorStatus(t.db, uid)).toEqual({ enabled: true, recoveryCodesLeft: 10 })
    const stored = await t.db.selectFrom("recovery_codes").select("code_hash").where("user_id", "=", uid).execute()
    expect(stored.map((r) => r.code_hash).join()).not.toContain(codes[0].replace("-", ""))
    // Enrolment can't be restarted (and the secret replaced) while it is on.
    expect(await beginEnrolment(t.db, uid)).toBeNull()
  })

  it("never accepts the same code (or an older one) twice", async () => {
    // The enrolment code's step is used up.
    expect(await verifySecondFactor(t.db, uid, totpCode(secret, T0), T0)).toEqual({ ok: false })
    const next = T0 + 30_000
    expect(await verifySecondFactor(t.db, uid, totpCode(secret, next), next)).toEqual({ ok: true, method: "totp" })
    expect(await verifySecondFactor(t.db, uid, totpCode(secret, next), next)).toEqual({ ok: false })
    // Still inside the ±1 window, but older than the last accepted step.
    expect(await verifySecondFactor(t.db, uid, totpCode(secret, T0), next)).toEqual({ ok: false })
  })

  it("accepts each recovery code exactly once, in any case", async () => {
    expect(await verifySecondFactor(t.db, uid, codes[0].toLowerCase())).toEqual({ ok: true, method: "recovery" })
    expect(await verifySecondFactor(t.db, uid, codes[0])).toEqual({ ok: false })
    expect(await verifySecondFactor(t.db, uid, "ZZZZZ-ZZZZZ")).toEqual({ ok: false })
    expect((await twoFactorStatus(t.db, uid)).recoveryCodesLeft).toBe(9)
  })

  it("only lets one of two concurrent requests use a code", async () => {
    const at = T0 + 90_000
    const results = await Promise.all([
      verifySecondFactor(t.db, uid, totpCode(secret, at), at),
      verifySecondFactor(t.db, uid, totpCode(secret, at), at),
    ])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
  })

  it("regenerates recovery codes, invalidating the old ones", async () => {
    const fresh = (await regenerateRecoveryCodes(t.db, uid))!
    expect(fresh).toHaveLength(10)
    expect(await verifySecondFactor(t.db, uid, codes[1])).toEqual({ ok: false })
    expect(await verifySecondFactor(t.db, uid, fresh[0])).toEqual({ ok: true, method: "recovery" })
  })

  it("forgets everything when turned off (or reset by an admin)", async () => {
    await disableTwoFactor(t.db, uid)
    expect(await twoFactorStatus(t.db, uid)).toEqual({ enabled: false, recoveryCodesLeft: 0 })
    const row = await t.db.selectFrom("users").select(["totp_secret", "totp_last_step"]).where("id", "=", uid).executeTakeFirstOrThrow()
    expect(row).toEqual({ totp_secret: null, totp_last_step: null })
    expect(await regenerateRecoveryCodes(t.db, uid)).toBeNull()
  })
})
