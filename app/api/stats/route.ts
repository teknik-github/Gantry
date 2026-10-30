import { authorizeRequest } from "@/lib/server/api-auth"
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
// Any role in the environment (viewers see the dashboard too).
export async function GET() {
  const auth = await authorizeRequest("view")
  if (auth.response) return auth.response

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
