import "server-only"

import { readFileSync } from "node:fs"
import os from "node:os"

import { parseSelfIds, type SelfIds } from "@/lib/server/docker/recreate"

let cached: SelfIds | undefined

function read(path: string) {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

/**
 * Ids of the container Gantry runs in (empty when it runs on the host). The
 * Docker image sets HOSTNAME=0.0.0.0 for Next.js, so the kernel hostname is
 * used as well: by default it is the container id prefix.
 */
export function selfContainerIds(): SelfIds {
  cached ??= parseSelfIds({
    cgroup: read("/proc/self/cgroup"),
    mountinfo: read("/proc/self/mountinfo"),
    hostnames: [os.hostname(), process.env.HOSTNAME],
  })
  return cached
}
