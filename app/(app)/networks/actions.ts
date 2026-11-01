"use server"

import { z } from "zod"

import { BULK_LIMIT, uniqueBy } from "@/lib/bulk"
import { getI18n } from "@/lib/i18n/server"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { expectedEnvironment, inEnvironment, runAction, runBulkAction, UserError } from "@/lib/server/action"
import { fieldErrors, type ActionState } from "@/lib/validation"

const BUILTIN = new Set(["bridge", "host", "none"])

export async function createNetwork(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = z
    .object({
      name: z
        .string()
        .trim()
        .min(1, t.networks.nameRequired)
        .max(128)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, t.networks.nameFormat),
      driver: z.enum(["bridge", "overlay", "macvlan", "ipvlan"]).default("bridge"),
    })
    .safeParse({ name: formData.get("name"), driver: formData.get("driver") || undefined })
  if (!parsed.success) return fieldErrors(parsed.error)

  return runAction(inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD))), "network.create", parsed.data.name, async ({ docker }) => {
    await (await docker()).createNetwork(parsed.data.name, parsed.data.driver)
    return format(t.networks.created, { name: parsed.data.name })
  })
}

export async function removeNetwork(id: string, name: string, environmentId?: number): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = z.string().regex(/^[a-f0-9]{12,64}$/).safeParse(id)
  if (!parsed.success) return { error: t.networks.invalidId }

  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "network.remove", name, async ({ docker }) => {
    if (BUILTIN.has(name)) throw new UserError(t.networks.builtinCannotBeRemoved)
    await (await docker()).removeNetwork(parsed.data)
    return t.networks.removed
  })
}

export async function removeNetworks(targets: { id: string; name: string }[], environmentId?: number): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = z
    .array(z.object({ id: z.string().regex(/^[a-f0-9]{12,64}$/), name: z.string().max(255) }))
    .min(1)
    .max(BULK_LIMIT)
    .safeParse(targets)
  if (!parsed.success) return { error: t.networks.invalidRequest }

  return runBulkAction(
    inEnvironment("manage", expectedEnvironment(environmentId)),
    "network.remove",
    uniqueBy(parsed.data, (n) => n.id),
    {
      verb: "Removed",
      noun: "network",
      localized: { verb: t.networks.bulkVerb, noun: t.networks.bulkNoun },
      label: (n) => n.name || n.id.slice(0, 12),
    },
    async (n, docker) => {
      if (BUILTIN.has(n.name)) throw new UserError(t.networks.builtinCannotBeRemoved)
      await docker.removeNetwork(n.id)
    }
  )
}
