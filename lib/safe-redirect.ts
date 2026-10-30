const BASE = "http://gantry.invalid"

/**
 * Post-login redirect target from the `next` form field. Only same-site
 * relative paths are allowed, which blocks open redirects such as
 * "//evil.com", "/\evil.com", "https://evil.com" and "/\t/evil.com" (URL
 * parsers drop tabs and newlines, turning it into "//evil.com"). The value is
 * resolved like a browser would and must stay on our origin.
 */
export function safeNext(value: unknown, fallback = "/dashboard") {
  const next = typeof value === "string" ? value : ""
  // No control characters, whitespace or backslashes anywhere.
  if (!/^\/(?![/\\])/.test(next) || /[\u0000- \u007f\\]/.test(next)) return fallback
  try {
    const url = new URL(next, BASE)
    if (url.origin !== BASE) return fallback
    return url.pathname + url.search + url.hash
  } catch {
    return fallback
  }
}
