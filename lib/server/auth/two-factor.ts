import "server-only"

import type { Kysely } from "kysely"

import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  verifyTotp,
} from "@/lib/server/auth/totp"
import { decryptSecret, encryptSecret } from "@/lib/server/crypto"
import type { Database } from "@/lib/server/db/schema"

// Storage side of TOTP two-factor authentication. Kept free of request APIs
// so it can be tested against a real database. The secret is encrypted at
// rest (bound to the user id) and never sent to the browser after enrolment.

const secretContext = (userId: number) => `users.totp_secret:${userId}`

export type TwoFactorStatus = { enabled: boolean; recoveryCodesLeft: number }

export async function twoFactorStatus(db: Kysely<Database>, userId: number): Promise<TwoFactorStatus> {
  const [user, codes] = await Promise.all([
    db.selectFrom("users").select("totp_enabled").where("id", "=", userId).executeTakeFirst(),
    db
      .selectFrom("recovery_codes")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("user_id", "=", userId)
      .where("used_at", "is", null)
      .executeTakeFirstOrThrow(),
  ])
  return { enabled: Number(user?.totp_enabled ?? 0) === 1, recoveryCodesLeft: Number(codes.n) }
}

/**
 * Starts (or restarts) enrolment: a fresh secret is stored, still disabled,
 * and returned once so it can be shown as a QR code. Refused while 2FA is on.
 */
export async function beginEnrolment(db: Kysely<Database>, userId: number): Promise<string | null> {
  const secret = generateTotpSecret()
  const res = await db
    .updateTable("users")
    .set({ totp_secret: encryptSecret(secret, secretContext(userId)), totp_last_step: null })
    .where("id", "=", userId)
    .where("totp_enabled", "=", 0)
    .executeTakeFirst()
  return Number(res.numUpdatedRows) === 1 ? secret : null
}

async function storedSecret(db: Kysely<Database>, userId: number) {
  const row = await db
    .selectFrom("users")
    .select(["totp_secret", "totp_enabled"])
    .where("id", "=", userId)
    .executeTakeFirst()
  if (!row?.totp_secret) return null
  return { secret: decryptSecret(row.totp_secret, secretContext(userId)), enabled: Number(row.totp_enabled) === 1 }
}

/**
 * Accepts `code` for the user's stored secret only if its time step is newer
 * than the last accepted one, so a code (or an older one) can't be replayed
 * within its window. The update is conditional, so two concurrent requests
 * with the same code can't both succeed.
 */
async function acceptTotp(db: Kysely<Database>, userId: number, secret: string, code: string, nowMs?: number) {
  const step = verifyTotp(secret, code, nowMs)
  if (step === null) return false
  const res = await db
    .updateTable("users")
    .set({ totp_last_step: step })
    .where("id", "=", userId)
    .where((eb) => eb.or([eb("totp_last_step", "is", null), eb("totp_last_step", "<", step)]))
    .executeTakeFirst()
  return Number(res.numUpdatedRows) === 1
}

async function replaceRecoveryCodes(db: Kysely<Database>, userId: number): Promise<string[]> {
  const codes = generateRecoveryCodes()
  const now = new Date().toISOString()
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("recovery_codes").where("user_id", "=", userId).execute()
    await trx
      .insertInto("recovery_codes")
      .values(codes.map((c) => ({ user_id: userId, code_hash: hashRecoveryCode(c), created_at: now })))
      .execute()
  })
  return codes
}

/**
 * Finishes enrolment when `code` matches the pending secret: turns 2FA on
 * and returns the recovery codes (shown once). Null if the code is wrong.
 */
export async function confirmEnrolment(
  db: Kysely<Database>,
  userId: number,
  code: string,
  nowMs?: number
): Promise<string[] | null> {
  const stored = await storedSecret(db, userId)
  if (!stored || stored.enabled) return null
  if (!(await acceptTotp(db, userId, stored.secret, code, nowMs))) return null
  await db.updateTable("users").set({ totp_enabled: 1 }).where("id", "=", userId).execute()
  return replaceRecoveryCodes(db, userId)
}

export type CodeCheck = { ok: true; method: "totp" | "recovery" } | { ok: false }

/**
 * Second factor at login (and when disabling 2FA): a current TOTP code, or
 * one of the unused recovery codes, which is then spent.
 */
export async function verifySecondFactor(
  db: Kysely<Database>,
  userId: number,
  input: string,
  nowMs?: number
): Promise<CodeCheck> {
  const stored = await storedSecret(db, userId)
  if (!stored?.enabled) return { ok: false }
  const code = input.trim()
  if (/^\d[\d\s]*$/.test(code)) {
    return (await acceptTotp(db, userId, stored.secret, code, nowMs)) ? { ok: true, method: "totp" } : { ok: false }
  }
  if (!normalizeRecoveryCode(code)) return { ok: false }
  // Lookup by hash: the codes are random, so timing reveals nothing useful.
  const res = await db
    .updateTable("recovery_codes")
    .set({ used_at: new Date().toISOString() })
    .where("user_id", "=", userId)
    .where("code_hash", "=", hashRecoveryCode(code))
    .where("used_at", "is", null)
    .executeTakeFirst()
  return Number(res.numUpdatedRows) === 1 ? { ok: true, method: "recovery" } : { ok: false }
}

/** New set of recovery codes; the old ones stop working. Only while 2FA is on. */
export async function regenerateRecoveryCodes(db: Kysely<Database>, userId: number): Promise<string[] | null> {
  const status = await twoFactorStatus(db, userId)
  if (!status.enabled) return null
  return replaceRecoveryCodes(db, userId)
}

/** Turns 2FA off and forgets the secret and recovery codes (user or admin reset). */
export async function disableTwoFactor(db: Kysely<Database>, userId: number) {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("users")
      .set({ totp_enabled: 0, totp_secret: null, totp_last_step: null })
      .where("id", "=", userId)
      .execute()
    await trx.deleteFrom("recovery_codes").where("user_id", "=", userId).execute()
  })
}
