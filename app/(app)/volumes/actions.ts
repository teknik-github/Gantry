"use server"

import { z } from "zod"

import { BULK_LIMIT } from "@/lib/bulk"
import type { I18n } from "@/lib/i18n"
import { getI18n } from "@/lib/i18n/server"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { expectedEnvironment, inEnvironment, runAction, runBulkAction } from "@/lib/server/action"
import { releaseVolumeHelpers } from "@/lib/server/files/helper"
import { fieldErrors, type ActionState } from "@/lib/validation"

const nameSchema = (t: I18n["t"]) =>
  z
    .string()
    .trim()
    .min(1, t.volumes.nameRequired)
    .max(128)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, t.volumes.nameFormat)

export async function createVolume(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = z
    .object({ name: nameSchema(t), driver: z.string().trim().max(64).default("local") })
    .safeParse({ name: formData.get("name"), driver: formData.get("driver") || undefined })
  if (!parsed.success) return fieldErrors(parsed.error)

  return runAction(inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD))), "volume.create", parsed.data.name, async ({ docker }) => {
    await (await docker()).createVolume(parsed.data.name, parsed.data.driver)
    return format(t.volumes.created, { name: parsed.data.name })
  })
}

export async function removeVolume(name: string, environmentId?: number): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = nameSchema(t).safeParse(name)
  if (!parsed.success) return { error: t.volumes.invalidName }

  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "volume.remove", name, async ({ docker }) => {
    const api = await docker()
    // Idle file browser helpers would keep the volume "in use".
    await releaseVolumeHelpers(api.target, parsed.data)
    await api.removeVolume(parsed.data)
    return t.volumes.removed
  })
}

export async function removeVolumes(names: string[], environmentId?: number): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = z.array(nameSchema(t)).min(1).max(BULK_LIMIT).safeParse(names)
  if (!parsed.success) return { error: t.volumes.invalidRequest }

  return runBulkAction(
    inEnvironment("manage", expectedEnvironment(environmentId)),
    "volume.remove",
    [...new Set(parsed.data)],
    { verb: "Removed", noun: "volume", localized: { verb: t.volumes.bulkVerb, noun: t.volumes.bulkNoun }, label: (n) => n },
    async (name, docker) => {
      await releaseVolumeHelpers(docker.target, name)
      await docker.removeVolume(name)
    }
  )
}
