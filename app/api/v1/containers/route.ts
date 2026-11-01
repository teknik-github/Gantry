import { containerName } from "@/lib/format"
import { authorizeRequest } from "@/lib/server/api-auth"
import { getDocker } from "@/lib/server/environments"
import { errorResponse } from "@/lib/server/http"

export type ContainerListResponse = {
  environment: { id: number; name: string }
  containers: {
    id: string
    name: string
    image: string
    state: string
    status: string
    /** Unix seconds */
    created: number
    ports: { ip: string | null; private: number; public: number | null; type: string }[]
    /** Compose project, if any */
    stack: string | null
  }[]
}

/**
 * Read-only container list of the current environment for scripts:
 *   curl -H "Authorization: Bearer gtk_..." [-H "X-Gantry-Environment: 2"] /api/v1/containers
 * Any role in the environment. Labels, environment variables and mounts are
 * left out on purpose (they may hold secrets); use the UI for details.
 */
export async function GET() {
  const auth = await authorizeRequest("view")
  if (auth.response) return auth.response
  const env = auth.environment
  if (!env) return Response.json({ error: "No environment selected" }, { status: 404 })
  if (env.type === "kubernetes") return Response.json({ error: "This is a Kubernetes environment" }, { status: 409 })

  try {
    const containers = await (await getDocker(env.id)).listContainers(true)
    const body: ContainerListResponse = {
      environment: { id: env.id, name: env.name },
      containers: containers.map((c) => ({
        id: c.Id,
        name: containerName(c),
        image: c.Image,
        state: c.State,
        status: c.Status,
        created: c.Created,
        ports: c.Ports.map((p) => ({ ip: p.IP ?? null, private: p.PrivatePort, public: p.PublicPort ?? null, type: p.Type })),
        stack: c.Labels?.["com.docker.compose.project"] ?? null,
      })),
    }
    return Response.json(body, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    return errorResponse(err, "/api/v1/containers")
  }
}
