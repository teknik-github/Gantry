"use server"

import { z } from "zod"

import { runAction } from "@/lib/server/action"
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

  return runAction("admin", "volume.create", parsed.data.name, async ({ docker }) => {
    await (await docker()).createVolume(parsed.data.name, parsed.data.driver)
    return `Volume ${parsed.data.name} created`
  })
}

export async function removeVolume(name: string): Promise<ActionState> {
  const parsed = nameSchema.safeParse(name)
  if (!parsed.success) return { error: "Invalid volume name" }

  return runAction("admin", "volume.remove", name, async ({ docker }) => {
    await (await docker()).removeVolume(parsed.data)
    return "Volume removed"
  })
}
