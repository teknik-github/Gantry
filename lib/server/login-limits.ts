/** Failed logins allowed per account per window, whatever the source address. */
export const ACCOUNT_LIMIT = 10
/** Failed logins allowed per (client IP, account) when the client IP is trustworthy. */
export const CLIENT_LIMIT = 5
export const LOGIN_WINDOW_MS = 5 * 60_000

type HeaderGetter = { get(name: string): string | null }

/**
 * Client address for rate limiting. Forwarding headers are written by the
 * client unless a reverse proxy we control overwrites them, so they are only
 * used with TRUST_PROXY=true. The right-most X-Forwarded-For entry is the
 * one appended by that proxy; anything left of it is client-controlled.
 */
export function clientAddress(headers: HeaderGetter, trustProxy: boolean): string | null {
  if (!trustProxy) return null
  const hops = headers.get("x-forwarded-for")?.split(",").map((h) => h.trim()).filter(Boolean)
  return hops?.at(-1) || headers.get("x-real-ip")?.trim() || null
}

/**
 * Rate-limit buckets a login attempt counts against. The per-account bucket
 * can't be dodged by rotating headers; the per-client bucket only exists when
 * the address can be trusted and lets one noisy client be stopped earlier.
 *
 * A browser holding a device cookie for this account (`deviceId`, set by an
 * earlier complete login) counts against its own bucket instead of the
 * account's: an attacker filling the account bucket can't lock the owner out,
 * and still gets only ACCOUNT_LIMIT guesses per window without such a cookie.
 */
export function loginRateKeys(username: string, address: string | null, deviceId: string | null = null) {
  const account = username.trim().toLowerCase()
  const keys = [
    deviceId
      ? { key: `login:device:${deviceId}:${account}`, limit: ACCOUNT_LIMIT }
      : { key: `login:account:${account}`, limit: ACCOUNT_LIMIT },
  ]
  if (address) keys.push({ key: `login:client:${address}:${account}`, limit: CLIENT_LIMIT })
  return keys
}

/** Failed second-factor codes allowed per account per window (6 digits: keep it small). */
export const TWO_FACTOR_LIMIT = 5

/**
 * Failed logins are audited on the first failure of a bucket's window and
 * when it locks, not on every attempt, so a password-guessing run can't grow
 * the audit log without bound.
 */
export function shouldAuditFailure(count: number, limit: number) {
  return count === 1 || count === limit
}

/**
 * What the audit log records for a failed login: the username only when it
 * belongs to an account. Anything else may well be a password typed into the
 * wrong field.
 */
export function auditedLoginName(username: string, exists: boolean) {
  return exists ? username.trim().slice(0, 64) : "(unknown user)"
}
