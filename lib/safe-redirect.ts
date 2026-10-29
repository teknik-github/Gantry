/**
 * Post-login redirect target from the `next` form field. Only same-site
 * relative paths are allowed, which blocks open redirects such as
 * "//evil.com", "/\evil.com" or "https://evil.com".
 */
export function safeNext(value: unknown, fallback = "/dashboard") {
  const next = typeof value === "string" ? value : ""
  return /^\/(?![/\\])/.test(next) ? next : fallback
}
