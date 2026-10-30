"use server"

import { z } from "zod"

import { BULK_LIMIT } from "@/lib/bulk"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { expectedEnvironment, inEnvironment, runAction, runBulkAction } from "@/lib/server/action"
import { fieldErrors, type ActionState } from "@/lib/validation"

const nameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "Letters, numbers, dot, dash or underscore")

export async function createVolume(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ name: nameSchema, driver: z.string().trim().max(64).default("local") })
    .safeParse({ name: formData.get("name"), driver: formData.get("driver") || undefined })
  if (!parsed.success) return fieldErrors(parsed.error)

  return runAction(inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD))), "volume.create", parsed.data.name, async ({ docker }) => {
    await (await docker()).createVolume(parsed.data.name, parsed.data.driver)
    return `Volume ${parsed.data.name} created`
  })
}

export async function removeVolume(name: string, environmentId?: number): Promise<ActionState> {
  const parsed = nameSchema.safeParse(name)
  if (!parsed.success) return { error: "Invalid volume name" }

  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "volume.remove", name, async ({ docker }) => {
    await (await docker()).removeVolume(parsed.data)
    return "Volume removed"
  })
}

export async function removeVolumes(names: string[], environmentId?: number): Promise<ActionState> {
  const parsed = z.array(nameSchema).min(1).max(BULK_LIMIT).safeParse(names)
  if (!parsed.success) return { error: "Invalid request" }

  return runBulkAction(
    inEnvironment("manage", expectedEnvironment(environmentId)),
    "volume.remove",
    [...new Set(parsed.data)],
    { verb: "Removed", noun: "volume", label: (n) => n },
    (name, docker) => docker.removeVolume(name).then(() => {})
  )
}
