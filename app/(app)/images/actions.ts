"use server"

import { z } from "zod"

import { BULK_LIMIT, uniqueBy } from "@/lib/bulk"
import { getI18n } from "@/lib/i18n/server"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { expectedEnvironment, inEnvironment, runAction, runBulkAction } from "@/lib/server/action"
import { fieldErrors, type ActionState } from "@/lib/validation"

const imageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "Invalid image id")

export async function pullImage(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = z
    .object({
      image: z
        .string()
        .trim()
        .min(1, t.images.imageRequired)
        .max(255)
        .regex(/^[a-z0-9][a-z0-9._\-/:@]*$/i, t.images.imageFormat),
    })
    .safeParse({ image: formData.get("image") })
  if (!parsed.success) return fieldErrors(parsed.error)

  return runAction(inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD))), "image.pull", parsed.data.image, async ({ docker }) => {
    await (await docker()).pullImage(parsed.data.image)
    return format(t.images.pulled, { image: parsed.data.image })
  })
}

export async function removeImage(id: string, force = false, environmentId?: number): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = imageIdSchema.safeParse(id)
  if (!parsed.success) return { error: t.images.invalidId }

  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "image.remove", id, async ({ docker }) => {
    await (await docker()).removeImage(parsed.data, force === true)
    return t.images.removed
  })
}

export async function removeImages(
  targets: { id: string; name: string }[],
  force = false,
  environmentId?: number
): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = z
    .array(z.object({ id: imageIdSchema, name: z.string().max(255) }))
    .min(1)
    .max(BULK_LIMIT)
    .safeParse(targets)
  if (!parsed.success) return { error: t.images.invalidRequest }

  return runBulkAction(
    inEnvironment("manage", expectedEnvironment(environmentId)),
    "image.remove",
    uniqueBy(parsed.data, (i) => i.id),
    {
      verb: "Removed",
      noun: "image",
      localized: { verb: t.images.bulkVerb, noun: t.images.bulkNoun },
      label: (i) => i.name || i.id.slice(7, 19),
      auditTarget: (i) => i.id,
    },
    (i, docker) => docker.removeImage(i.id, force === true).then(() => {})
  )
}

export async function pruneImages(environmentId?: number): Promise<ActionState> {
  const { t, format, formatBytes } = await getI18n()
  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "image.prune", "dangling", async ({ docker }) => {
    const res = await (await docker()).pruneImages()
    return format(t.images.pruned, { count: res.ImagesDeleted?.length ?? 0, size: formatBytes(res.SpaceReclaimed) })
  })
}
