import "server-only"

import { DockerError } from "@/lib/server/docker/client"
import { KubeError } from "@/lib/server/kubernetes/client"

// Shared pieces of route handler responses (app/api/*).

export const NO_STORE = { "Cache-Control": "no-store" } as const

/** A JSON response that is never cached. */
export function json(status: number, body: object): Response {
  return Response.json(body, { status, headers: NO_STORE })
}

/**
 * The status a route handler answers with for a DockerError or KubeError
 * (`status` is the error's): the one rule for every handler.
 *
 * - Client errors pass through: 400 (invalid input), 403 (no environment),
 *   404 (no such container, file...), 409 (conflict, environment switched or
 *   of the other kind)...
 * - Except 401: Docker or the cluster refusing Gantry's credentials is not
 *   the browser's session expiring, and clients send the user to /login on
 *   a 401. It becomes 502.
 * - 504 stays: Docker or the cluster did not answer in time.
 * - Anything else (daemon unreachable, a 5xx from upstream, a TLS or stored
 *   credential problem, odd statuses) is 502: the failure is behind Gantry.
 */
export function upstreamStatus(status: number): number {
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 401) return status
  if (status === 504) return 504
  return 502
}

/**
 * JSON error response for whatever a route handler caught: Docker and
 * Kubernetes errors with their message (they are written for the user) and
 * the status from upstreamStatus(); anything else is logged as
 * "[gantry] <what> failed" and answered with a generic 500, without its
 * message (it may name hosts, paths or SQL).
 */
export function errorResponse(err: unknown, what: string): Response {
  if (err instanceof DockerError || err instanceof KubeError) {
    return json(upstreamStatus(err.status), { error: err.message })
  }
  console.error(`[gantry] ${what} failed`, err)
  return json(500, { error: "Something went wrong. Check the server logs." })
}
