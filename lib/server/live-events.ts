import "server-only"

import type { Environment } from "@/lib/server/db/schema"
import { dockerEventSource } from "@/lib/server/docker/events"
import { EventHub, type HubListener } from "@/lib/server/event-hub"

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
export function subscribeToEnvironment(env: Pick<Environment, "id" | "type" | "url">, listener: HubListener) {
  const key = `${env.id}:${env.type}:${env.url}`
  return hub().subscribe(key, dockerEventSource({ type: env.type, url: env.url }), listener)
}
