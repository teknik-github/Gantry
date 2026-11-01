import "server-only"

import { containerName } from "@/lib/format"
import type { ContainerSummary } from "@/lib/server/docker/api"
import { CONFIG_FILES_LABEL, SERVICE_LABEL } from "@/lib/server/stacks"
import { stackStatus } from "@/lib/stacks"
import type { StackContainer } from "@/components/gantry/stacks-table"

/** Running/total counts and per-container rows for one compose project. */
export function summarizeProject(containers: ContainerSummary[]) {
  const list: StackContainer[] = containers
    .map((c) => ({
      id: c.Id,
      name: containerName(c),
      service: c.Labels?.[SERVICE_LABEL] ?? "",
      state: c.State,
    }))
    .sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name))
  const running = list.filter((c) => c.state === "running").length
  return {
    containers: list,
    running,
    total: list.length,
    status: stackStatus(running, list.length),
    configFiles: containers[0]?.Labels?.[CONFIG_FILES_LABEL] ?? null,
  }
}
