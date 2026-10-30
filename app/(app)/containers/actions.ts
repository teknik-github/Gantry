"use server"

import { z } from "zod"

import { containerNameField, imageField, parseEnv, parsePorts, parseVolumes, splitArgs } from "@/lib/container-form"
import { BULK_LIMIT, uniqueBy } from "@/lib/bulk"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { authorize, expectedEnvironment, inEnvironment, runAction, runBulkAction, UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import { CONTAINER_ACTIONS, type ContainerAction } from "@/lib/server/docker/api"
import { DockerError } from "@/lib/server/docker/client"
import { ExecSessionError, openExecSession } from "@/lib/server/docker/exec"
import { isSelfContainer } from "@/lib/server/docker/recreate"
import { selfContainerIds } from "@/lib/server/docker/self"
import { environmentTarget } from "@/lib/server/environments"
import { fieldErrors, type ActionState } from "@/lib/validation"

const idSchema = z.string().regex(/^[a-f0-9]{12,64}$/, "Invalid container id")

// Every action takes the id of the environment the page was rendered for
// (components/gantry/environment-scope.tsx); it is refused if the selected
// environment changed since.

export async function containerAction(id: string, action: ContainerAction, environmentId?: number): Promise<ActionState> {
  const parsed = z.object({ id: idSchema, action: z.enum(CONTAINER_ACTIONS) }).safeParse({ id, action })
  if (!parsed.success) return { error: "Invalid request" }

  return runAction(inEnvironment("operate", expectedEnvironment(environmentId)), `container.${action}`, id, async ({ docker }) => {
    await (await docker()).containerAction(parsed.data.id, parsed.data.action)
  })
}

export async function removeContainer(
  id: string,
  opts: { force?: boolean; volumes?: boolean } = {},
  environmentId?: number
): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid container id" }

  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "container.remove", id, async ({ docker }) => {
    await (await docker()).removeContainer(parsed.data, {
      force: opts.force === true,
      volumes: opts.volumes === true,
    })
    return "Container removed"
  })
}

const targetsSchema = z
  .array(z.object({ id: idSchema, name: z.string().max(255) }))
  .min(1, "Nothing selected")
  .max(BULK_LIMIT)

export type BulkTarget = { id: string; name: string }

const PAST: Record<ContainerAction, string> = {
  start: "Started",
  stop: "Stopped",
  restart: "Restarted",
  pause: "Paused",
  unpause: "Resumed",
  kill: "Killed",
}

/** Stopping (or removing) the container Gantry runs in would cut the request off halfway. */
function refuseSelf(id: string) {
  if (isSelfContainer({ Id: id }, selfContainerIds())) throw new UserError("Gantry runs in this container; do it on its own")
}

export async function bulkContainerAction(
  targets: BulkTarget[],
  action: ContainerAction,
  environmentId?: number
): Promise<ActionState> {
  const parsed = z.object({ targets: targetsSchema, action: z.enum(CONTAINER_ACTIONS) }).safeParse({ targets, action })
  if (!parsed.success) return { error: "Invalid request" }
  const { action: act } = parsed.data

  return runBulkAction(
    inEnvironment("operate", expectedEnvironment(environmentId)),
    `container.${act}`,
    uniqueBy(parsed.data.targets, (t) => t.id),
    { verb: PAST[act], noun: "container", label: (t) => t.name || t.id.slice(0, 12), auditTarget: (t) => t.id },
    async (t, docker) => {
      if (act !== "start" && act !== "unpause") refuseSelf(t.id)
      await docker.containerAction(t.id, act)
    }
  )
}

export async function removeContainers(
  targets: BulkTarget[],
  opts: { force?: boolean; volumes?: boolean } = {},
  environmentId?: number
): Promise<ActionState> {
  const parsed = targetsSchema.safeParse(targets)
  if (!parsed.success) return { error: "Invalid request" }

  return runBulkAction(
    inEnvironment("manage", expectedEnvironment(environmentId)),
    "container.remove",
    uniqueBy(parsed.data, (t) => t.id),
    { verb: "Removed", noun: "container", label: (t) => t.name || t.id.slice(0, 12), auditTarget: (t) => t.id },
    async (t, docker) => {
      refuseSelf(t.id)
      await docker.removeContainer(t.id, { force: opts.force === true, volumes: opts.volumes === true })
    }
  )
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

  return runAction(inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD))), "container.create", v.name || v.image, async ({ docker }) => {
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
  environmentId: z.number().int().positive().optional(),
})

/**
 * Opens an interactive shell in a container. Exec is equivalent to full
 * control of the container, so it needs the manager role and is audited.
 */
export async function startExecSession(input: {
  id: string
  shell: ExecShell
  user: string
  cols: number
  rows: number
  environmentId?: number
}): Promise<{ sid: string; error?: never } | { sid?: never; error: string }> {
  const parsed = execSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid request" }
  const { id, shell, cols, rows } = parsed.data

  const auth = await authorize(inEnvironment("manage", parsed.data.environmentId))
  if ("error" in auth) return { error: auth.error }
  const { user, environment: env } = auth
  if (!env) return { error: "No Docker environment configured" }

  try {
    const sid = await openExecSession({
      userId: user.id,
      environmentId: env.id,
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
