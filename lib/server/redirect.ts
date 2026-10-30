import "server-only"

/**
 * Route handler redirect to a path of this site with a relative Location,
 * so the browser stays on the host it used (request.url can name another
 * one, e.g. localhost in the standalone server or behind a proxy).
 */
export function redirectTo(path: string) {
  return new Response(null, { status: 307, headers: { Location: path, "Cache-Control": "no-store" } })
}
