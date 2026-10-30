import "server-only"

import {
  demuxLogs,
  dockerJson,
  dockerRaw,
  DockerError,
  type DockerTarget,
} from "@/lib/server/docker/client"
import { registryAuthHeader, registryServerAddress, type RegistryCredentials } from "@/lib/registry"

// Minimal shapes of the Docker Engine API responses Gantry uses.

export type ContainerSummary = {
  Id: string
  Names: string[]
  Image: string
  ImageID: string
  Command: string
  Created: number
  State: string
  Status: string
  Ports: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[]
  Labels: Record<string, string>
  Mounts: { Type: string; Name?: string; Source: string; Destination: string; Driver?: string; Mode?: string; RW?: boolean }[]
  NetworkSettings: {
    Networks: Record<
      string,
      { NetworkID: string; IPAddress: string; Aliases?: string[] | null; DNSNames?: string[] | null }
    >
  }
  HostConfig?: { NetworkMode?: string }
}

export type ContainerInspect = {
  Id: string
  Name: string
  Created: string
  Path: string
  Args: string[]
  State: {
    Status: string
    Running: boolean
    Paused: boolean
    Restarting: boolean
    ExitCode: number
    StartedAt: string
    FinishedAt: string
    Health?: { Status: string }
  }
  Image: string
  RestartCount: number
  Config: {
    Hostname: string
    Image: string
    Env: string[] | null
    Cmd: string[] | null
    Entrypoint: string[] | null
    WorkingDir: string
    Labels: Record<string, string> | null
    Tty: boolean
  }
  HostConfig: {
    RestartPolicy: { Name: string; MaximumRetryCount: number }
    PortBindings: Record<string, { HostIp: string; HostPort: string }[] | null> | null
    NetworkMode: string
    Privileged: boolean
  }
  Mounts: { Type: string; Name?: string; Source: string; Destination: string; Mode: string; RW: boolean }[]
  NetworkSettings: {
    Networks: Record<
      string,
      { IPAddress: string; Gateway: string; MacAddress: string; NetworkID?: string; Aliases?: string[] | null }
    >
  }
}

export type ImageSummary = {
  Id: string
  RepoTags: string[] | null
  RepoDigests: string[] | null
  Created: number
  Size: number
  Containers: number
}

export type ImageInspect = {
  Id: string
  RepoTags: string[] | null
  RepoDigests: string[] | null
  Config: Record<string, unknown> | null
}

export type Volume = {
  Name: string
  Driver: string
  Mountpoint: string
  CreatedAt?: string
  Labels: Record<string, string> | null
  Scope: string
}

export type Network = {
  Id: string
  Name: string
  Driver: string
  Scope: string
  Created: string
  Internal: boolean
  IPAM: { Config: { Subnet?: string; Gateway?: string }[] | null }
  Containers?: Record<string, unknown>
  Labels?: Record<string, string> | null
}

export type DockerInfo = {
  ID: string
  Name: string
  ServerVersion: string
  OperatingSystem: string
  OSType: string
  Architecture: string
  NCPU: number
  MemTotal: number
  Containers: number
  ContainersRunning: number
  ContainersPaused: number
  ContainersStopped: number
  Images: number
}

export type ContainerStats = {
  read: string
  cpu_stats: {
    cpu_usage: { total_usage: number }
    system_cpu_usage?: number
    online_cpus?: number
  }
  precpu_stats: {
    cpu_usage: { total_usage: number }
    system_cpu_usage?: number
  }
  memory_stats: { usage?: number; limit?: number; stats?: Record<string, number> }
}

export const CONTAINER_ACTIONS = ["start", "stop", "restart", "pause", "unpause", "kill"] as const
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number]

/** Docker ids and names (images are always addressed by id): safe path segments only. */
function seg(value: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value) || value.includes("..")) {
    throw new DockerError("Invalid identifier", 400)
  }
  return encodeURIComponent(value)
}

/** Image references may contain "/" (registry/namespace); encode each part. */
function imageRefPath(reference: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(reference) || reference.includes("..") || reference.includes("//")) {
    throw new DockerError("Invalid image reference", 400)
  }
  return reference.split("/").map(encodeURIComponent).join("/")
}

export type DockerOptions = {
  /** Login for the registry of an image reference (private pulls, update checks). */
  credentials?: (reference: string) => Promise<RegistryCredentials | null>
}

export function docker(target: DockerTarget, options: DockerOptions = {}) {
  async function authHeaders(reference: string): Promise<Record<string, string>> {
    const cred = await options.credentials?.(reference)
    return cred ? { "X-Registry-Auth": registryAuthHeader(cred) } : {}
  }

  return {
    /** The endpoint this client talks to (used to point the docker CLI at it, e.g. for stacks). */
    target,
    ping: () => dockerRaw(target, "GET", "/_ping", { timeoutMs: 5_000 }).then(() => true),
    info: () => dockerJson<DockerInfo>(target, "GET", "/info", { timeoutMs: 10_000 }),

    // Containers
    listContainers: (all = true) =>
      dockerJson<ContainerSummary[]>(target, "GET", "/containers/json", { query: { all } }),
    inspectContainer: (id: string) =>
      dockerJson<ContainerInspect>(target, "GET", `/containers/${seg(id)}/json`),
    containerAction: (id: string, action: ContainerAction) =>
      dockerRaw(target, "POST", `/containers/${seg(id)}/${action}`, { timeoutMs: 60_000 }),
    removeContainer: (id: string, opts: { force?: boolean; volumes?: boolean } = {}) =>
      dockerRaw(target, "DELETE", `/containers/${seg(id)}`, {
        query: { force: opts.force ?? false, v: opts.volumes ?? false },
      }),
    async containerLogs(id: string, tail = 500) {
      const info = await this.inspectContainer(id)
      const { body } = await dockerRaw(target, "GET", `/containers/${seg(id)}/logs`, {
        query: { stdout: 1, stderr: 1, timestamps: 1, tail },
      })
      return info.Config.Tty ? body.toString("utf8") : demuxLogs(body)
    },
    containerStats: (id: string) =>
      dockerJson<ContainerStats>(target, "GET", `/containers/${seg(id)}/stats`, {
        query: { stream: false },
        timeoutMs: 10_000,
      }),
    createContainer: (name: string | undefined, spec: Record<string, unknown>) =>
      dockerJson<{ Id: string; Warnings: string[] }>(target, "POST", "/containers/create", {
        query: { name },
        body: spec,
      }),

    /** Extracts a tar archive into `path` inside the container. */
    putArchive: (id: string, path: string, tar: Buffer) =>
      dockerRaw(target, "PUT", `/containers/${seg(id)}/archive`, {
        query: { path },
        rawBody: { data: tar, contentType: "application/x-tar" },
      }),
    /** Runs a command in a running container and waits for it (no TTY); output is stdout+stderr. */
    async execRun(id: string, cmd: string[], timeoutMs = 60_000) {
      const { Id } = await dockerJson<{ Id: string }>(target, "POST", `/containers/${seg(id)}/exec`, {
        body: { Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false },
      })
      const { body } = await dockerRaw(target, "POST", `/exec/${seg(Id)}/start`, {
        body: { Detach: false, Tty: false },
        timeoutMs,
      })
      const info = await dockerJson<{ ExitCode: number | null; Running: boolean }>(target, "GET", `/exec/${seg(Id)}/json`)
      return { exitCode: info.ExitCode ?? -1, output: demuxLogs(body) }
    },
    renameContainer: (id: string, name: string) =>
      dockerRaw(target, "POST", `/containers/${seg(id)}/rename`, { query: { name } }),

    // Images
    /** By id or by reference ("nginx:latest", "ghcr.io/org/app:1"). */
    inspectImage: (reference: string) =>
      dockerJson<ImageInspect>(target, "GET", `/images/${imageRefPath(reference)}/json`),
    // Slow with the containerd image store on a busy host (tens of seconds).
    listImages: () => dockerJson<ImageSummary[]>(target, "GET", "/images/json", { timeoutMs: 120_000 }),
    removeImage: (id: string, force = false) =>
      dockerRaw(target, "DELETE", `/images/${seg(id)}`, { query: { force } }),
    async pullImage(reference: string) {
      const { image, tag } = splitImageRef(reference)
      const { body } = await dockerRaw(target, "POST", "/images/create", {
        query: { fromImage: image, tag },
        headers: await authHeaders(reference),
        timeoutMs: 15 * 60_000,
      })
      // Pull progress is streamed as JSON lines; failures arrive as {"error": ...}.
      for (const line of body.toString("utf8").split("\n")) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          if (msg.error) throw new DockerError(msg.error, 500)
        } catch (err) {
          if (err instanceof DockerError) throw err
        }
      }
    },
    /** Digest the registry currently serves for a reference (no pull). */
    async distributionInspect(reference: string) {
      return dockerJson<{ Descriptor: { digest: string; mediaType?: string } }>(
        target,
        "GET",
        `/distribution/${imageRefPath(reference)}/json`,
        { headers: await authHeaders(reference), timeoutMs: 30_000 }
      )
    },
    /** Checks a registry login through the daemon (POST /auth); throws on bad credentials. */
    registryLogin: (cred: RegistryCredentials) =>
      dockerJson<{ Status?: string }>(target, "POST", "/auth", {
        body: {
          username: cred.username,
          password: cred.password,
          serveraddress: registryServerAddress(cred.address),
        },
        timeoutMs: 30_000,
      }),
    pruneImages: () =>
      dockerJson<{ SpaceReclaimed: number; ImagesDeleted: unknown[] | null }>(
        target,
        "POST",
        "/images/prune",
        { query: { filters: JSON.stringify({ dangling: ["true"] }) }, timeoutMs: 120_000 }
      ),

    // Volumes
    listVolumes: () =>
      dockerJson<{ Volumes: Volume[] | null }>(target, "GET", "/volumes").then((r) => r.Volumes ?? []),
    createVolume: (name: string, driver = "local") =>
      dockerJson<Volume>(target, "POST", "/volumes/create", { body: { Name: name, Driver: driver } }),
    removeVolume: (name: string, force = false) =>
      dockerRaw(target, "DELETE", `/volumes/${seg(name)}`, { query: { force } }),

    // Networks
    listNetworks: () => dockerJson<Network[]>(target, "GET", "/networks"),
    createNetwork: (name: string, driver = "bridge") =>
      dockerJson<{ Id: string }>(target, "POST", "/networks/create", {
        body: { Name: name, Driver: driver, CheckDuplicate: true },
      }),
    removeNetwork: (id: string) => dockerRaw(target, "DELETE", `/networks/${seg(id)}`),
    connectNetwork: (network: string, container: string, endpoint?: Record<string, unknown>) =>
      dockerRaw(target, "POST", `/networks/${seg(network)}/connect`, {
        body: { Container: container, EndpointConfig: endpoint ?? {} },
      }),
  }
}

export type DockerApi = ReturnType<typeof docker>

export function splitImageRef(reference: string) {
  const ref = reference.trim()
  if (ref.includes("@")) return { image: ref, tag: undefined }
  // A colon after the last slash is a tag; one before it is a registry port.
  const lastSlash = ref.lastIndexOf("/")
  const lastColon = ref.lastIndexOf(":")
  if (lastColon > lastSlash) {
    return { image: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) }
  }
  return { image: ref, tag: "latest" }
}

/** CPU % the same way `docker stats` computes it. */
export function cpuPercent(s: ContainerStats) {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage
  const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0)
  const cpus = s.cpu_stats.online_cpus ?? 1
  if (cpuDelta <= 0 || sysDelta <= 0) return 0
  return (cpuDelta / sysDelta) * cpus * 100
}

/** Memory usage excluding page cache, like `docker stats`. */
export function memoryUsage(s: ContainerStats) {
  const usage = s.memory_stats.usage ?? 0
  const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0
  return Math.max(0, usage - cache)
}
