import { getCurrentUser } from "@/lib/server/auth/dal"
import { DockerError } from "@/lib/server/docker/client"
import { getDocker } from "@/lib/server/environments"
import { sampleHost } from "@/lib/server/metrics"

export type StatsResponse = {
  ts: number
  cpu: number
  memory: number
  memTotal: number
  ncpu: number
  /** All running containers (only the first MAX_CONTAINERS are sampled). */
  running: number
  containers: { id: string; name: string; cpu: number; memory: number }[]
}

const MAX_CONTAINERS = 30

// Live resource usage of running containers, polled by the dashboard chart.
export async function GET() {
  if (!(await getCurrentUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const usage = await sampleHost(await getDocker(), {
      maxContainers: MAX_CONTAINERS,
      concurrency: MAX_CONTAINERS,
    })
    const body: StatsResponse = {
      ts: Date.now(),
      cpu: usage.cpu,
      memory: usage.memory,
      memTotal: usage.memTotal,
      ncpu: usage.ncpu,
      running: usage.running,
      containers: usage.containers.sort((a, b) => b.memory - a.memory),
    }
    return Response.json(body, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    const status = err instanceof DockerError ? 502 : 500
    return Response.json({ error: (err as Error).message }, { status })
  }
}
