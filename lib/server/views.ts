import "server-only"

import { timeAgo } from "@/lib/format"
import { DockerError } from "@/lib/server/docker/client"
import type { ContainerSummary } from "@/lib/server/docker/api"
import type { ContainerRow } from "@/components/gantry/containers-table"

export function toContainerRows(list: ContainerSummary[]): ContainerRow[] {
  return list.map((c) => {
    const ports = new Set<string>()
    for (const p of c.Ports) {
      // Docker lists IPv4 and IPv6 bindings separately; show each mapping once.
      ports.add(p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`)
    }
    return {
      id: c.Id,
      name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
      image: c.Image,
      state: c.State,
      status: c.Status,
      created: c.Created,
      createdLabel: timeAgo(c.Created),
      ports: [...ports].sort(),
      stack: c.Labels["com.docker.compose.project"] ?? null,
    }
  })
}

/** Runs Docker calls and turns connection failures into a renderable error. */
export async function tryDocker<T>(fn: () => Promise<T>): Promise<{ data: T; error?: never } | { data?: never; error: string }> {
  try {
    return { data: await fn() }
  } catch (err) {
    if (err instanceof DockerError) return { error: err.message }
    if (err instanceof Error && err.message === "No Docker environment configured") return { error: err.message }
    throw err
  }
}
