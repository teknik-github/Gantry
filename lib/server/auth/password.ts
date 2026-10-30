import "server-only"

import crypto from "node:crypto"
import { promisify } from "node:util"

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const KEYLEN = 64

// Format: scrypt$N$r$p$salt$hash (base64url)
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(password, salt, KEYLEN, PARAMS)
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), hash.toString("base64url")].join("$")
}

/** Thrown when too many password checks are already waiting. */
export class PasswordBusyError extends Error {
  constructor() {
    super("Too many sign-in attempts right now. Try again in a moment.")
  }
}

/**
 * Global cap on concurrent scrypt verifications (each costs ~16 MB and tens
 * of ms of CPU). Rate limits are per account, so a stream of attempts with
 * ever new usernames would otherwise get unlimited scrypt work; with the cap
 * it queues behind MAX_ACTIVE slots and is refused beyond MAX_QUEUED.
 */
const MAX_ACTIVE = 2
const MAX_QUEUED = 32
let active = 0
const queue: (() => void)[] = []

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_ACTIVE) {
    if (queue.length >= MAX_QUEUED) throw new PasswordBusyError()
    await new Promise<void>((resolve) => queue.push(resolve))
  } else {
    active++
  }
  try {
    return await fn()
  } finally {
    // Hand the slot to the next waiter, or free it.
    const next = queue.shift()
    if (next) next()
    else active--
  }
}

/** Constant-work check: an unusable stored hash (e.g. SSO-only accounts) still costs one scrypt run. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$")
  if (parts[0] !== "scrypt" || !parts[4] || !parts[5]) {
    await verifyHash(password, (await getDummyHash()).split("$"))
    return false
  }
  return verifyHash(password, parts)
}

async function verifyHash(password: string, [, n, r, p, salt, hash]: string[]): Promise<boolean> {
  const expected = Buffer.from(hash, "base64url")
  const actual = await withSlot(() =>
    scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMS.maxmem,
    })
  )
  return crypto.timingSafeEqual(actual, expected)
}

// Used to keep login timing similar when the username does not exist.
let dummyHash: Promise<string> | undefined
export function getDummyHash() {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex"))
  return dummyHash
}
