"use server"

import { z } from "zod"

import { runAction, UserError } from "@/lib/server/action"
import { fieldErrors, type ActionState } from "@/lib/validation"

const BUILTIN = new Set(["bridge", "host", "none"])

export async function createNetwork(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({
      name: z
        .string()
        .trim()
        .min(1, "Name is required")
        .max(128)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, "Letters, numbers, dot, dash or underscore"),
      driver: z.enum(["bridge", "overlay", "macvlan", "ipvlan"]).default("bridge"),
    })
    .safeParse({ name: formData.get("name"), driver: formData.get("driver") || undefined })
  if (!parsed.success) return fieldErrors(parsed.error)

  return runAction("admin", "network.create", parsed.data.name, async ({ docker }) => {
    await (await docker()).createNetwork(parsed.data.name, parsed.data.driver)
    return `Network ${parsed.data.name} created`
  })
}

export async function removeNetwork(id: string, name: string): Promise<ActionState> {
  const parsed = z.string().regex(/^[a-f0-9]{12,64}$/).safeParse(id)
  if (!parsed.success) return { error: "Invalid network id" }

  return runAction("admin", "network.remove", name, async ({ docker }) => {
    if (BUILTIN.has(name)) throw new UserError("Built-in networks cannot be removed")
    await (await docker()).removeNetwork(parsed.data)
    return "Network removed"
  })
}
