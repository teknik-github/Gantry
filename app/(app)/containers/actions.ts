"use server"

import { z } from "zod"

import { containerNameField, imageField, parseEnv, parsePorts, parseVolumes, splitArgs } from "@/lib/container-form"
import { runAction, UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { CONTAINER_ACTIONS, type ContainerAction } from "@/lib/server/docker/api"
import { DockerError } from "@/lib/server/docker/client"
import { ExecSessionError, openExecSession } from "@/lib/server/docker/exec"
import { environmentTarget, getCurrentEnvironment } from "@/lib/server/environments"
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

const createSchema = z.object({
  image: imageField,
  name: containerNameField,
  ports: z.string().max(2000),
  env: z.string().max(20000),
  volumes: z.string().max(4000),
  restart: z.enum(["no", "always", "unless-stopped", "on-failure"]),
  command: z.string().max(2000),
  pull: z.enum(["on"]).optional(),
  start: z.enum(["on"]).optional(),
})

export async function createContainer(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = createSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return fieldErrors(parsed.error)
  const v = parsed.data

  const ports = parsePorts(v.ports)
  if (!ports.ok) return { error: ports.error, fieldErrors: { ports: [ports.fieldError] } }
  const { exposed, bindings } = ports.value

  const envResult = parseEnv(v.env)
  if (!envResult.ok) return { error: envResult.error, fieldErrors: { env: [envResult.fieldError] } }
  const env = envResult.value

  const volumes = parseVolumes(v.volumes)
  if (!volumes.ok) return { error: volumes.error, fieldErrors: { volumes: [volumes.fieldError] } }
  const binds = volumes.value

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
      target: environmentTarget(env),
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
