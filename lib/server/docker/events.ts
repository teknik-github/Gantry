import "server-only"

import http from "node:http"

import { DOCKER_EVENT_FILTERS, toLiveEvent } from "@/lib/live"
import { connectionOptions, DockerError, type DockerTarget } from "@/lib/server/docker/client"
import type { HubSource } from "@/lib/server/event-hub"

/** Splits a byte stream of newline-delimited JSON into parsed values. */
export function createJsonLineParser(onValue: (value: unknown) => void) {
  let pending = ""
  return (chunk: Buffer | string) => {
    pending += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    let nl: number
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl).trim()
      pending = pending.slice(nl + 1)
      if (!line) continue
      try {
        onValue(JSON.parse(line))
      } catch {
        // Not JSON; skip the line rather than kill the stream.
      }
    }
    // Guard against a peer that never sends a newline.
    if (pending.length > 1024 * 1024) pending = ""
  }
}

/**
 * HubSource for Docker's GET /events, filtered to the events Gantry shows.
 * The request has no timeout: Docker keeps it open until it stops or the
 * signal aborts.
 */
export function dockerEventSource(target: DockerTarget): HubSource {
  return ({ onOpen, onEvent }, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return resolve()
      const query = new URLSearchParams({ filters: JSON.stringify(DOCKER_EVENT_FILTERS) })
      const req = http.request(
        {
          ...connectionOptions(target),
          method: "GET",
          path: `/events?${query}`,
          headers: { Host: "docker" },
          signal,
          // Only until Docker answers; the stream itself may idle for hours.
          timeout: 10_000,
        },
        (res) => {
          req.setTimeout(0)
          if ((res.statusCode ?? 0) !== 200) {
            res.resume()
            reject(new DockerError(`Docker events failed (${res.statusCode})`, res.statusCode ?? 502))
            return
          }
          res.socket?.setKeepAlive(true, 30_000)
          onOpen()
          const parse = createJsonLineParser((raw) => {
            const event = toLiveEvent(raw)
            if (event) onEvent(event)
          })
          res.on("data", parse)
          res.on("end", () => resolve())
          res.on("close", () => resolve())
          res.on("error", (err) => (signal.aborted ? resolve() : reject(err)))
        }
      )
      req.on("timeout", () => req.destroy(new DockerError("Docker did not answer in time", 504)))
      req.on("error", (err: NodeJS.ErrnoException) => {
        if (signal.aborted) return resolve()
        if (err instanceof DockerError) return reject(err)
        reject(new DockerError(`Cannot reach Docker (${err.code ?? err.message})`, 502))
      })
      req.end()
    })
}
