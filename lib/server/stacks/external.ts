import "server-only"

import { z } from "zod"

import { containerName } from "@/lib/format"
import type { ContainerAction, ContainerSummary, DockerApi } from "@/lib/server/docker/api"
import { isSelfContainer, pullAndRecreate, type RecreateApi, type SelfIds } from "@/lib/server/docker/recreate"
import { PROJECT_LABEL } from "@/lib/server/stacks"

/**
 * Operations on compose projects Gantry doesn't manage ("External projects").
 * Their compose file is usually out of Gantry's reach (another host, or a path
 * its container can't see), so these act on the project's containers through
 * the Docker API, the way `docker compose` would:
 *
 *  - start/stop/restart: every container of the project, started oldest first
 *    and stopped newest first (compose created them in dependency order);
 *  - redeploy: pull each container's image and recreate it when it changed
 *    (same as "Pull & recreate" on a container, keeping its compose labels);
 *  - remove: remove the containers and the project's networks, and with
 *    removeVolumes its named volumes too (`docker compose down [-v]`).
 */
export const EXTERNAL_OPERATIONS = ["start", "stop", "restart", "redeploy", "remove"] as const
export type ExternalOperation = (typeof EXTERNAL_OPERATIONS)[number]

/** Compose project names: lowercase letters, digits, "-" and "_", starting with a letter or digit. */
export const composeProjectSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,254}$/)

export type ExternalApi = Pick<DockerApi, "listContainers" | "containerAction" | "removeContainer" | "listNetworks" | "removeNetwork" | "listVolumes" | "removeVolume"> &
  RecreateApi

export type ExternalResult = {
  /** Containers (or, for remove, containers, networks and volumes) acted on. */
  done: number
  /** redeploy: containers whose image was already the newest. */
  unchanged: number
  /** "name: reason" for every object that failed; the others still ran. */
  failures: string[]
}

export class ExternalProjectError extends Error {
  constructor(readonly reason: "notFound" | "selfContainer") {
    super(reason)
  }
}

const byCreated = (a: ContainerSummary, b: ContainerSummary) => a.Created - b.Created

export async function runExternalOperation(
  api: ExternalApi,
  project: string,
  op: ExternalOperation,
  opts: { removeVolumes?: boolean; self?: SelfIds } = {}
): Promise<ExternalResult> {
  const containers = (await api.listContainers(true)).filter((c) => c.Labels?.[PROJECT_LABEL] === project)
  if (containers.length === 0) throw new ExternalProjectError("notFound")
  // Stopping, recreating or removing the container Gantry (or its agent) runs
  // in would cut this request off halfway.
  if (op !== "start" && containers.some((c) => isSelfContainer(c, opts.self))) {
    throw new ExternalProjectError("selfContainer")
  }

  const result: ExternalResult = { done: 0, unchanged: 0, failures: [] }
  const attempt = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
      result.done++
    } catch (err) {
      result.failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const action = (list: ContainerSummary[], act: ContainerAction) =>
    list.reduce<Promise<void>>(
      (prev, c) => prev.then(() => attempt(containerName(c), () => api.containerAction(c.Id, act))),
      Promise.resolve()
    )

  const oldestFirst = [...containers].sort(byCreated)
  const newestFirst = [...oldestFirst].reverse()
  const running = (c: ContainerSummary) => c.State === "running" || c.State === "restarting"

  switch (op) {
    case "start":
      await action(
        oldestFirst.filter((c) => !running(c) && c.State !== "paused"),
        "start"
      )
      break
    case "stop":
      await action(newestFirst.filter(running), "stop")
      break
    case "restart":
      await action(oldestFirst, "restart")
      break
    case "redeploy":
      for (const c of oldestFirst) {
        await attempt(containerName(c), async () => {
          const r = await pullAndRecreate(api, { id: c.Id, self: opts.self })
          if (!r.updated) result.unchanged++
        })
      }
      // Up-to-date containers were counted as done too; report them separately.
      result.done -= result.unchanged
      break
    case "remove": {
      // Stop gracefully first, as `compose down` does; removal then forces
      // whatever didn't stop.
      for (const c of newestFirst.filter(running)) {
        await api.containerAction(c.Id, "stop").catch(() => {})
      }
      for (const c of newestFirst) {
        await attempt(containerName(c), () => api.removeContainer(c.Id, { force: true, volumes: opts.removeVolumes === true }))
      }
      const networks = (await api.listNetworks()).filter((n) => n.Labels?.[PROJECT_LABEL] === project)
      for (const n of networks) await attempt(n.Name, () => api.removeNetwork(n.Id))
      if (opts.removeVolumes) {
        const volumes = (await api.listVolumes()).filter((v) => v.Labels?.[PROJECT_LABEL] === project)
        for (const v of volumes) await attempt(v.Name, () => api.removeVolume(v.Name))
      }
      break
    }
  }
  return result
}
