import { getCurrentUser } from "@/lib/server/auth/dal"
import { cpuPercent, memoryUsage } from "@/lib/server/docker/api"
import { DockerError } from "@/lib/server/docker/client"
import { getDocker } from "@/lib/server/environments"

export type StatsResponse = {
  ts: number
  cpu: number
  memory: number
  memTotal: number
  ncpu: number
  containers: { id: string; name: string; cpu: number; memory: number }[]
}

const MAX_CONTAINERS = 30

// Live resource usage of running containers, polled by the dashboard chart.
export async function GET() {
  if (!(await getCurrentUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const api = await getDocker()
    const [info, running] = await Promise.all([api.info(), api.listContainers(false)])

    const samples = await Promise.all(
      running.slice(0, MAX_CONTAINERS).map(async (c) => {
        try {
          const s = await api.containerStats(c.Id)
          return {
            id: c.Id,
            name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
            cpu: cpuPercent(s),
            memory: memoryUsage(s),
          }
        } catch {
          return null // container stopped mid-request
        }
      })
    )
    const containers = samples.filter((s) => s !== null)

    const body: StatsResponse = {
      ts: Date.now(),
      // Normalised to the whole host (100% = all CPUs busy).
      cpu: containers.reduce((a, c) => a + c.cpu, 0) / Math.max(1, info.NCPU),
      memory: containers.reduce((a, c) => a + c.memory, 0),
      memTotal: info.MemTotal,
      ncpu: info.NCPU,
      containers: containers.sort((a, b) => b.memory - a.memory),
    }
    return Response.json(body, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    const status = err instanceof DockerError ? 502 : 500
    return Response.json({ error: (err as Error).message }, { status })
  }
}
