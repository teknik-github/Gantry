"use server"

import { z } from "zod"

import { containerNameField, imageField, RESTART_POLICIES } from "@/lib/container-form"
import { BULK_LIMIT, uniqueBy } from "@/lib/bulk"
import { runAction, runBulkAction, UserError } from "@/lib/server/action"
import { getCurrentUser } from "@/lib/server/auth/dal"
import {
  editsFromForm,
  formValuesFromInspect,
  networksEditable,
  pullAndRecreate,
  recreateContainer,
  RecreateError,
  type ContainerEdits,
  type RecreateInspect,
} from "@/lib/server/docker/recreate"
import { selfContainerIds } from "@/lib/server/docker/self"
import { getCurrentEnvironment, getDocker } from "@/lib/server/environments"
import { checkReferences, containerReferences, containerUpdates, referencesOf } from "@/lib/server/image-updates"
import { tryDocker } from "@/lib/server/views"
import { fieldErrors, type ActionState } from "@/lib/validation"

/** ActionState plus the id of the replacement container (the id changes on recreate). */
export type RecreateState = ActionState & { containerId?: string }

const idSchema = z.string().regex(/^[a-f0-9]{12,64}$/, "Invalid container id")

const editSchema = z.object({
  id: idSchema,
  image: imageField,
  name: containerNameField.min(1, "Name is required"),
  command: z.string().max(2000),
  env: z.string().max(20000),
  ports: z.string().max(2000),
  volumes: z.string().max(4000),
  restart: z.enum(RESTART_POLICIES),
  networks: z.array(z.string().max(255)).max(50).optional(),
  pull: z.enum(["on"]).optional(),
})

async function asUserError<T>(fn: () => Promise<T>) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof RecreateError) throw new UserError(err.message)
    throw err
  }
}

const FIELD_LABELS: Record<keyof ContainerEdits, string> = {
  image: "image",
  name: "name",
  cmd: "command",
  env: "env",
  ports: "ports",
  volumes: "volumes",
  restart: "restart policy",
  networks: "networks",
}

/** Edit form: recreates the container with the changed settings. */
export async function editContainer(_prev: RecreateState, formData: FormData): Promise<RecreateState> {
  const user = await getCurrentUser()
  if (!user) return { error: "Your session has expired. Please sign in again." }
  if (user.role !== "admin") return { error: "Only administrators can do this." }

  const parsed = editSchema.safeParse({
    ...Object.fromEntries(formData),
    // Checkboxes: only present when the form shows the network list.
    networks: formData.get("networksShown") ? formData.getAll("networks").map(String) : undefined,
  })
  if (!parsed.success) return fieldErrors(parsed.error)
  const { id, pull, ...submitted } = parsed.data

  // Compare against the container as it is now, not as the form saw it.
  const current = await tryDocker(async () => {
    const api = await getDocker()
    const c = (await api.inspectContainer(id)) as unknown as RecreateInspect
    const known = submitted.networks && networksEditable(c) ? (await api.listNetworks()).map((n) => n.Name) : []
    return { c, known }
  })
  if (current.error !== undefined) return { error: current.error }
  const { c, known } = current.data
  const diff = editsFromForm(formValuesFromInspect(c), submitted, known)
  if (!diff.ok) return { error: diff.error, fieldErrors: diff.fieldErrors }

  const changed = Object.keys(diff.edits) as (keyof ContainerEdits)[]
  if (changed.length === 0 && pull !== "on") return { ok: true, message: "No changes to apply", containerId: c.Id }

  const name = c.Name.replace(/^\//, "")
  const target = `${name} (${changed.map((k) => FIELD_LABELS[k]).join(", ") || "pull"})`
  let containerId: string | undefined
  const res = await runAction("admin", "container.edit", target, async ({ docker }) =>
    asUserError(async () => {
      const result = await recreateContainer(await docker(), {
        id: c.Id,
        edits: diff.edits,
        pull: pull === "on",
        self: selfContainerIds(),
      })
      containerId = result.id
      return [`${result.name} recreated`, ...result.warnings].join(". ")
    })
  )
  return { ...res, containerId }
}

/** Pulls the container's image reference and recreates it if the image changed. */
export async function pullAndRecreateContainer(id: string): Promise<RecreateState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid container id" }

  let containerId: string | undefined
  const res = await runAction("admin", "container.pull-recreate", id.slice(0, 12), async ({ docker }) =>
    asUserError(async () => {
      const result = await pullAndRecreate(await docker(), { id: parsed.data, self: selfContainerIds() })
      if (!result.updated) {
        containerId = parsed.data
        return `Already up to date: ${result.image} has not changed`
      }
      containerId = result.id
      return [`${result.name} updated to the latest image`, ...result.warnings].join(". ")
    })
  )
  return { ...res, containerId }
}

/**
 * "Pull & recreate" for several containers. Two at a time: each one pulls and
 * swaps containers, which is slow and heavy on the daemon.
 */
export async function bulkPullAndRecreate(targets: { id: string; name: string }[]): Promise<ActionState> {
  const parsed = z
    .array(z.object({ id: idSchema, name: z.string().max(255) }))
    .min(1)
    .max(BULK_LIMIT)
    .safeParse(targets)
  if (!parsed.success) return { error: "Invalid request" }

  return runBulkAction(
    "admin",
    "container.pull-recreate",
    uniqueBy(parsed.data, (t) => t.id),
    { verb: "Updated", noun: "container", label: (t) => t.name || t.id.slice(0, 12), auditTarget: (t) => t.id.slice(0, 12), concurrency: 2 },
    async (t, api) => {
      await asUserError(() => pullAndRecreate(api, { id: t.id, self: selfContainerIds() }))
    }
  )
}

/** Asks the registries which containers run an outdated image (no pull). */
export async function checkForUpdates(): Promise<ActionState> {
  return runAction("operate", "image.check-updates", "all", async ({ docker }) => {
    const env = await getCurrentEnvironment()
    if (!env) throw new UserError("No Docker environment configured")
    const api = await docker()
    const [containers, images] = await Promise.all([api.listContainers(true), api.listImages()])
    const byContainer = await containerReferences(api, containers)
    const refs = referencesOf(byContainer)
    if (!refs.length) return "No containers use an image tag that can be checked"
    const { checked, failed } = await checkReferences(env.id, api, refs)
    const updates = [...containerUpdates(env.id, containers, images, byContainer).values()].filter(
      (u) => u.status === "update"
    ).length
    const summary = updates ? `${updates} container(s) can be updated` : "everything is up to date"
    return `Checked ${checked} image tag(s): ${summary}${failed ? `. ${failed} tag(s) could not be checked` : ""}`
  })
}
