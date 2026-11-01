import "server-only"

import { StringDecoder } from "node:string_decoder"

import { isUnparsedLine, JsonLineParser } from "@/lib/image-build"
import { DOCKER_EVENT_FILTERS, toLiveEvent } from "@/lib/live"
import { DockerError, dockerRequest, type DockerTarget } from "@/lib/server/docker/client"
import type { HubSource } from "@/lib/server/event-hub"

/** Splits a byte stream of newline-delimited JSON into parsed values. */
export function createJsonLineParser(onValue: (value: unknown) => void) {
  // At most 1 MB without a newline: a peer that never sends one is cut off.
  const parser = new JsonLineParser(1024 * 1024)
  const decoder = new StringDecoder("utf8")
  return (chunk: Buffer | string) => {
    for (const value of parser.push(typeof chunk === "string" ? chunk : decoder.write(chunk))) {
      // Not JSON (or that runaway line): skip it rather than kill the stream.
      if (!isUnparsedLine(value)) onValue(value)
    }
  }
}

/**
 * Streams Docker's GET /events with `filters`, passing each raw event to
 * `onRaw`. The request has no timeout: Docker keeps it open until it stops
 * or the signal aborts. Resolves when the stream ends, rejects on failure.
 */
export function streamDockerEvents(
  target: DockerTarget,
  filters: Record<string, string[]>,
  handlers: { onOpen: () => void; onRaw: (raw: unknown) => void },
  signal: AbortSignal
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return resolve()
    const query = new URLSearchParams({ filters: JSON.stringify(filters) })
    // dockerRequest picks https and the client certificate for TLS environments.
    const req = dockerRequest(
      target,
      {
        method: "GET",
        path: `/events?${query}`,
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
        handlers.onOpen()
        res.on("data", createJsonLineParser(handlers.onRaw))
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

/** HubSource for Docker's GET /events, filtered to the events Gantry shows. */
export function dockerEventSource(target: DockerTarget): HubSource {
  return ({ onOpen, onEvent }, signal) =>
    streamDockerEvents(
      target,
      DOCKER_EVENT_FILTERS,
      {
        onOpen,
        onRaw: (raw) => {
          const event = toLiveEvent(raw)
          if (event) onEvent(event)
        },
      },
      signal
    )
}
