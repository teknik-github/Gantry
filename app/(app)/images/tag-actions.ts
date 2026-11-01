"use server"

import { z } from "zod"

import { parseImageReference } from "@/lib/image-build"
import { getI18n } from "@/lib/i18n/server"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { expectedEnvironment, inEnvironment, runAction } from "@/lib/server/action"
import { tagImage as dockerTagImage } from "@/lib/server/images/docker-stream"
import type { ActionState } from "@/lib/validation"

const imageIdSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "Invalid image id")

/** Images → Tag: adds another name to an image (POST /images/{id}/tag). */
export async function tagImage(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const id = imageIdSchema.safeParse(formData.get("id"))
  if (!id.success) return { error: t.images.invalidId }
  const text = typeof formData.get("reference") === "string" ? String(formData.get("reference")) : ""
  const parsed = parseImageReference(text)
  if (!parsed.ok) return { error: t.common.errors.fixFields, fieldErrors: { reference: [parsed.error] }, values: { reference: text } }
  const { repository, tag, reference } = parsed.value

  return runAction(
    inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD))),
    "image.tag",
    `${id.data} as ${reference}`,
    async ({ docker }) => {
      await dockerTagImage((await docker()).target, id.data, repository, tag)
      return format(t.images.tagged, { reference })
    }
  )
}
