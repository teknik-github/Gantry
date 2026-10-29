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

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, salt, hash] = stored.split("$")
  if (algo !== "scrypt" || !salt || !hash) return false
  const expected = Buffer.from(hash, "base64url")
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  })
  return crypto.timingSafeEqual(actual, expected)
}

// Used to keep login timing similar when the username does not exist.
let dummyHash: Promise<string> | undefined
export function getDummyHash() {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString("hex"))
  return dummyHash
}
