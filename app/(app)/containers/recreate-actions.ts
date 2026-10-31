"use server"

import { z } from "zod"

import { containerNameField, imageField, RESTART_POLICIES } from "@/lib/container-form"
import { BULK_LIMIT, uniqueBy } from "@/lib/bulk"
import type { I18n } from "@/lib/i18n"
import { getI18n } from "@/lib/i18n/server"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { authorize, expectedEnvironment, inEnvironment, runAction, runBulkAction, UserError } from "@/lib/server/action"
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
import { checkReferences, containerReferences, referencesOf, updatesFor } from "@/lib/server/image-updates"
import { tryDocker } from "@/lib/server/views"
import { fieldErrors, type ActionState } from "@/lib/validation"

/** ActionState plus the id of the replacement container (the id changes on recreate). */
export type RecreateState = ActionState & { containerId?: string }

const idSchema = z.string().regex(/^[a-f0-9]{12,64}$/, "Invalid container id")

const editSchema = (t: I18n["t"]) =>
  z.object({
    id: z.string().regex(/^[a-f0-9]{12,64}$/, t.containers.invalidId),
    image: imageField,
    name: containerNameField.min(1, t.containers.nameRequired),
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
  // Reading the container (env values included) needs the right first.
  const scope = inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD)))
  const auth = await authorize(scope)
  if ("error" in auth) return { error: auth.error }
  const { t, format } = await getI18n()

  const parsed = editSchema(t).safeParse({
    ...Object.fromEntries(formData),
    // Checkboxes: only present when the form shows the network list.
    networks: formData.get("networksShown") ? formData.getAll("networks").map(String) : undefined,
  })
  if (!parsed.success) return fieldErrors(parsed.error)
  const { id, pull, ...submitted } = parsed.data

  // Compare against the container as it is now, not as the form saw it.
  const current = await tryDocker(async () => {
    const api = await getDocker(scope.environmentId)
    const c = (await api.inspectContainer(id)) as unknown as RecreateInspect
    const known = submitted.networks && networksEditable(c) ? (await api.listNetworks()).map((n) => n.Name) : []
    return { c, known }
  })
  if (current.error !== undefined) return { error: current.error }
  const { c, known } = current.data
  const diff = editsFromForm(formValuesFromInspect(c), submitted, known)
  if (!diff.ok) return { error: diff.error, fieldErrors: diff.fieldErrors }

  const changed = Object.keys(diff.edits) as (keyof ContainerEdits)[]
  if (changed.length === 0 && pull !== "on") return { ok: true, message: t.containers.noChanges, containerId: c.Id }

  const name = c.Name.replace(/^\//, "")
  const target = `${name} (${changed.map((k) => FIELD_LABELS[k]).join(", ") || "pull"})`
  let containerId: string | undefined
  const res = await runAction(scope, "container.edit", target, async ({ docker }) =>
    asUserError(async () => {
      const result = await recreateContainer(await docker(), {
        id: c.Id,
        edits: diff.edits,
        pull: pull === "on",
        self: selfContainerIds(),
      })
      containerId = result.id
      return [format(t.containers.recreated, { name: result.name }), ...result.warnings].join(". ")
    })
  )
  return { ...res, containerId }
}

/** Pulls the container's image reference and recreates it if the image changed. */
export async function pullAndRecreateContainer(id: string, environmentId?: number): Promise<RecreateState> {
  const { t, format } = await getI18n()
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: t.containers.invalidId }

  let containerId: string | undefined
  const res = await runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "container.pull-recreate", id.slice(0, 12), async ({ docker }) =>
    asUserError(async () => {
      const result = await pullAndRecreate(await docker(), { id: parsed.data, self: selfContainerIds() })
      if (!result.updated) {
        containerId = parsed.data
        return format(t.containers.alreadyUpToDate, { image: result.image })
      }
      containerId = result.id
      return [format(t.containers.updatedToLatest, { name: result.name }), ...result.warnings].join(". ")
    })
  )
  return { ...res, containerId }
}

/**
 * "Pull & recreate" for several containers. Two at a time: each one pulls and
 * swaps containers, which is slow and heavy on the daemon.
 */
export async function bulkPullAndRecreate(targets: { id: string; name: string }[], environmentId?: number): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = z
    .array(z.object({ id: idSchema, name: z.string().max(255) }))
    .min(1)
    .max(BULK_LIMIT)
    .safeParse(targets)
  if (!parsed.success) return { error: t.containers.invalidRequest }

  return runBulkAction(
    inEnvironment("manage", expectedEnvironment(environmentId)),
    "container.pull-recreate",
    uniqueBy(parsed.data, (t) => t.id),
    {
      verb: "Updated",
      noun: "container",
      localized: { verb: t.containers.bulkVerbs.update, noun: t.containers.bulkNoun },
      label: (c) => c.name || c.id.slice(0, 12),
      auditTarget: (c) => c.id.slice(0, 12),
      concurrency: 2,
    },
    async (c, api) => {
      await asUserError(() => pullAndRecreate(api, { id: c.id, self: selfContainerIds() }))
    }
  )
}

/** Asks the registries which containers run an outdated image (no pull). */
export async function checkForUpdates(environmentId?: number): Promise<ActionState> {
  const { t, format } = await getI18n()
  return runAction(inEnvironment("operate", expectedEnvironment(environmentId)), "image.check-updates", "all", async ({ docker }) => {
    const env = await getCurrentEnvironment()
    if (!env) throw new UserError("No Docker environment configured")
    const api = await docker()
    const containers = await api.listContainers(true)
    const byContainer = await containerReferences(api, containers)
    const refs = referencesOf(byContainer)
    if (!refs.length) return t.containers.noCheckableTags
    const { checked, failed } = await checkReferences(env.id, api, refs)
    const updates = [...(await updatesFor(api, env.id, containers, byContainer)).updates.values()].filter(
      (u) => u.status === "update"
    ).length
    const summary = updates ? format(t.containers.canBeUpdated, { count: updates }) : t.containers.allUpToDate
    return failed
      ? format(t.containers.checkedTagsFailed, { count: checked, summary, failed })
      : format(t.containers.checkedTags, { count: checked, summary })
  })
}
