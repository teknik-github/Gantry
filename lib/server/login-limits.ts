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
 */
export function loginRateKeys(username: string, address: string | null) {
  const account = username.trim().toLowerCase()
  const keys = [{ key: `login:account:${account}`, limit: ACCOUNT_LIMIT }]
  if (address) keys.push({ key: `login:client:${address}:${account}`, limit: CLIENT_LIMIT })
  return keys
}
