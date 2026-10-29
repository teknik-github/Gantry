"use server"

import { z } from "zod"

import { runAction, UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { CONTAINER_ACTIONS, type ContainerAction } from "@/lib/server/docker/api"
import { DockerError } from "@/lib/server/docker/client"
import { ExecSessionError, openExecSession } from "@/lib/server/docker/exec"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { fieldErrors, type ActionState } from "@/lib/validation"

const idSchema = z.string().regex(/^[a-f0-9]{12,64}$/, "Invalid container id")

export async function containerAction(id: string, action: ContainerAction): Promise<ActionState> {
  const parsed = z.object({ id: idSchema, action: z.enum(CONTAINER_ACTIONS) }).safeParse({ id, action })
  if (!parsed.success) return { error: "Invalid request" }

  return runAction("operate", `container.${action}`, id, async ({ docker }) => {
    await (await docker()).containerAction(parsed.data.id, parsed.data.action)
  })
}

export async function removeContainer(id: string, opts: { force?: boolean; volumes?: boolean } = {}): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid container id" }

  return runAction("admin", "container.remove", id, async ({ docker }) => {
    await (await docker()).removeContainer(parsed.data, {
      force: opts.force === true,
      volumes: opts.volumes === true,
    })
    return "Container removed"
  })
}

const portRe = /^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/

const createSchema = z.object({
  image: z.string().trim().min(1, "Image is required").max(255),
  name: z
    .string()
    .trim()
    .max(128)
    .regex(/^([a-zA-Z0-9][a-zA-Z0-9_.-]*)?$/, "Letters, numbers, dot, dash or underscore"),
  ports: z.string().max(2000),
  env: z.string().max(20000),
  volumes: z.string().max(4000),
  restart: z.enum(["no", "always", "unless-stopped", "on-failure"]),
  command: z.string().max(2000),
  pull: z.enum(["on"]).optional(),
  start: z.enum(["on"]).optional(),
})

function lines(value: string) {
  return value
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
}

/** "a b 'c d'" -> ["a", "b", "c d"] */
function splitArgs(value: string) {
  return (value.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, "$2"))
}

export async function createContainer(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = createSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return fieldErrors(parsed.error)
  const v = parsed.data

  const exposed: Record<string, object> = {}
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {}
  for (const spec of lines(v.ports)) {
    const m = portRe.exec(spec)
    if (!m) return { error: "Invalid port mapping", fieldErrors: { ports: [`"${spec}" — use host:container, e.g. 8080:80`] } }
    const key = `${m[3]}/${m[4] ?? "tcp"}`
    exposed[key] = {}
    ;(bindings[key] ??= []).push({ HostIp: m[1] ?? "", HostPort: m[2] })
  }

  const env = lines(v.env)
  for (const e of env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) {
      return { error: "Invalid environment variable", fieldErrors: { env: [`"${e}" — use KEY=value`] } }
    }
  }

  const binds = lines(v.volumes)
  for (const b of binds) {
    if (!/^[^:]+:\/[^:]*(:(ro|rw))?$/.test(b)) {
      return { error: "Invalid volume", fieldErrors: { volumes: [`"${b}" — use volume-or-path:/container/path[:ro]`] } }
    }
  }

  return runAction("admin", "container.create", v.name || v.image, async ({ docker }) => {
    const api = await docker()
    if (v.pull === "on") await api.pullImage(v.image)

    const cmd = splitArgs(v.command)
    let created: { Id: string; Warnings: string[] }
    try {
      created = await api.createContainer(v.name || undefined, {
        Image: v.image,
        Env: env,
        Cmd: cmd.length ? cmd : undefined,
        ExposedPorts: exposed,
        HostConfig: {
          PortBindings: bindings,
          Binds: binds,
          RestartPolicy: { Name: v.restart === "no" ? "" : v.restart },
        },
      })
    } catch (err) {
      const msg = (err as Error).message
      if (/No such image/i.test(msg)) throw new UserError(`Image "${v.image}" not found locally. Enable "Pull image" and try again.`)
      throw err
    }

    if (v.start === "on") await api.containerAction(created.Id, "start")
    return `Container ${v.name || created.Id.slice(0, 12)} created`
  })
}

const SHELLS = {
  // Prefer bash when the image has it, otherwise plain sh.
  auto: ["/bin/sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"],
  bash: ["/bin/bash"],
  sh: ["/bin/sh"],
} as const

export type ExecShell = keyof typeof SHELLS

const execSchema = z.object({
  id: idSchema,
  shell: z.enum(Object.keys(SHELLS) as [ExecShell, ...ExecShell[]]),
  user: z
    .string()
    .trim()
    .max(64)
    .regex(/^([a-zA-Z0-9_.-]+(:[a-zA-Z0-9_.-]+)?)?$/, "Use user or user:group"),
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(4).max(200),
})

/**
 * Opens an interactive shell in a container. Exec is equivalent to full
 * control of the container, so it is limited to administrators and audited.
 */
export async function startExecSession(input: {
  id: string
  shell: ExecShell
  user: string
  cols: number
  rows: number
}): Promise<{ sid: string; error?: never } | { sid?: never; error: string }> {
  const user = await getCurrentUser()
  if (!user) return { error: "Your session has expired. Please sign in again." }
  if (user.role !== "admin") return { error: "Only administrators can open a console." }

  const parsed = execSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request" }
  const { id, shell, cols, rows } = parsed.data

  const env = await getCurrentEnvironment()
  if (!env) return { error: "No Docker environment configured" }

  try {
    const sid = await openExecSession({
      userId: user.id,
      target: { type: env.type, url: env.url },
      containerId: id,
      cmd: [...SHELLS[shell]],
      user: parsed.data.user || undefined,
      cols,
      rows,
    })
    await audit(user, "container.exec", `${id.slice(0, 12)} ${shell}${parsed.data.user ? ` as ${parsed.data.user}` : ""}`)
    return { sid }
  } catch (err) {
    if (err instanceof DockerError || err instanceof ExecSessionError) return { error: err.message }
    console.error("[gantry] exec failed", err)
    return { error: "Could not start the console. Check the server logs." }
  }
}
