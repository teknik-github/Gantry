import http from "node:http"

// Minimal Docker Engine client for test fixtures (throwaway containers).

const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock"

export function docker<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        method,
        path,
        headers: {
          ...extraHeaders,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          if ((res.statusCode ?? 500) >= 400) return reject(new Error(`${method} ${path}: ${res.statusCode} ${text}`))
          try {
            resolve((text ? JSON.parse(text) : undefined) as T)
          } catch {
            resolve(text as T) // streamed endpoints (image pull) return JSON lines
          }
        })
      }
    )
    req.on("error", reject)
    req.end(payload)
  })
}

export async function dockerAvailable() {
  try {
    await docker("GET", "/_ping")
    return true
  } catch {
    return false
  }
}

/** Starts a long-sleeping alpine container; returns its id. */
export async function startScratchContainer(name: string) {
  const image = "alpine:3"
  try {
    await docker("GET", `/images/${encodeURIComponent(image)}/json`)
  } catch {
    await docker("POST", `/images/create?fromImage=alpine&tag=3`)
  }
  const { Id } = await docker<{ Id: string }>("POST", `/containers/create?name=${name}`, {
    Image: image,
    Cmd: ["sleep", "900"],
    Labels: { "gantry.e2e": "true" },
  })
  await docker("POST", `/containers/${Id}/start`)
  return Id
}

export async function removeContainer(id: string) {
  await docker("DELETE", `/containers/${id}?force=true&v=true`).catch(() => {})
}
