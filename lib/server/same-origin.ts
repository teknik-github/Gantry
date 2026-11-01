import "server-only"

/**
 * Whether a browser says this request comes from another site. Only
 * same-origin requests and the user's own navigation ("none") may use the
 * API; scripts and API clients send no Sec-Fetch-Site at all. Checked by
 * proxy.ts, and by the upload routes that bypass it.
 */
export function isCrossSite(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site")
  return Boolean(site && site !== "same-origin" && site !== "none")
}
