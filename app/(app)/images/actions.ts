"use server"

import { z } from "zod"

import { formatBytes } from "@/lib/format"
import { BULK_LIMIT, uniqueBy } from "@/lib/bulk"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { expectedEnvironment, inEnvironment, runAction, runBulkAction } from "@/lib/server/action"
import { fieldErrors, type ActionState } from "@/lib/validation"

const imageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "Invalid image id")

export async function pullImage(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({
      image: z
        .string()
        .trim()
        .min(1, "Image is required")
        .max(255)
        .regex(/^[a-z0-9][a-z0-9._\-/:@]*$/i, "e.g. nginx:latest or ghcr.io/org/app:1.0"),
    })
    .safeParse({ image: formData.get("image") })
  if (!parsed.success) return fieldErrors(parsed.error)

  return runAction(inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD))), "image.pull", parsed.data.image, async ({ docker }) => {
    await (await docker()).pullImage(parsed.data.image)
    return `Pulled ${parsed.data.image}`
  })
}

export async function removeImage(id: string, force = false, environmentId?: number): Promise<ActionState> {
  const parsed = imageIdSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid image id" }

  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "image.remove", id, async ({ docker }) => {
    await (await docker()).removeImage(parsed.data, force === true)
    return "Image removed"
  })
}

export async function removeImages(
  targets: { id: string; name: string }[],
  force = false,
  environmentId?: number
): Promise<ActionState> {
  const parsed = z
    .array(z.object({ id: imageIdSchema, name: z.string().max(255) }))
    .min(1)
    .max(BULK_LIMIT)
    .safeParse(targets)
  if (!parsed.success) return { error: "Invalid request" }

  return runBulkAction(
    inEnvironment("manage", expectedEnvironment(environmentId)),
    "image.remove",
    uniqueBy(parsed.data, (t) => t.id),
    { verb: "Removed", noun: "image", label: (t) => t.name || t.id.slice(7, 19), auditTarget: (t) => t.id },
    (t, docker) => docker.removeImage(t.id, force === true).then(() => {})
  )
}

export async function pruneImages(environmentId?: number): Promise<ActionState> {
  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "image.prune", "dangling", async ({ docker }) => {
    const res = await (await docker()).pruneImages()
    return `Removed ${res.ImagesDeleted?.length ?? 0} image layer(s), reclaimed ${formatBytes(res.SpaceReclaimed)}`
  })
}
