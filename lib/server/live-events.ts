import "server-only"

import type { DockerEnvironmentType, Environment } from "@/lib/server/db/schema"
import { dockerEventSource } from "@/lib/server/docker/events"
import { EventHub, type HubListener } from "@/lib/server/event-hub"
import { environmentTarget } from "@/lib/server/environment-target"

// One hub per server process; kept on globalThis so dev hot reloads reuse
// the open Docker connections instead of leaking new ones.
const globalForEvents = globalThis as unknown as { __gantryEventHub?: EventHub }

const lastErrors = new Map<string, string>()

function hub() {
  return (globalForEvents.__gantryEventHub ??= new EventHub({
    onError(key, err) {
      // Log each distinct failure once instead of on every retry.
      const message = (err as Error)?.message ?? String(err)
      if (lastErrors.get(key) === message) return
      lastErrors.set(key, message)
      console.warn(`[gantry] docker events for environment ${key}: ${message}`)
    },
    onConnect(key) {
      lastErrors.delete(key)
    },
  }))
}

/** Subscribes to the live Docker events of an environment (shared upstream connection). */
export function subscribeToEnvironment(
  env: Environment & { type: DockerEnvironmentType },
  listener: HubListener
) {
  // Includes the TLS material, so tcp environments with mutual TLS work too. The
  // ciphertext tail changes whenever certificates are saved again (fresh IV),
  // which opens a new upstream with them.
  const key = `${env.id}:${env.type}:${env.url}:${env.tls_cert?.slice(-16) ?? "plain"}`
  return hub().subscribe(key, dockerEventSource(environmentTarget(env)), listener)
}
