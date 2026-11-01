"use server"

import { z } from "zod"

import type { I18n, Messages } from "@/lib/i18n"
import { getI18n } from "@/lib/i18n/server"
import { normalizeRegistryAddress, type RegistryCredentials } from "@/lib/registry"
import { runAction, UserError } from "@/lib/server/action"
import type { DockerApi } from "@/lib/server/docker/api"
import {
  deleteRegistry as deleteRegistryRecord,
  findRegistryByAddress,
  getRegistryCredentials,
  insertRegistry,
  listRegistries,
  updateRegistry as updateRegistryRecord,
} from "@/lib/server/registries"
import { SecretDecryptError } from "@/lib/server/crypto"
import { fieldErrors, type ActionState } from "@/lib/validation"

const idSchema = z.coerce.number().int().positive()

function registrySchema(t: Messages) {
  const e = t.registries.errors
  return z.object({
    name: z.string().trim().min(1, e.nameRequired).max(100),
    address: z
      .string()
      .trim()
      .min(1, e.addressRequired)
      .max(255)
      .transform((v, ctx) => {
        const address = normalizeRegistryAddress(v)
        if (!address) {
          ctx.addIssue({ code: "custom", message: e.addressInvalid })
          return z.NEVER
        }
        return address
      }),
    username: z.string().trim().min(1, e.usernameRequired).max(255),
    password: z.string().max(4096, e.tooLong),
    verify: z.enum(["on"]).optional(),
  })
}

function parseForm(formData: FormData, t: Messages) {
  const raw: Record<string, string> = {}
  for (const [k, v] of formData) if (typeof v === "string") raw[k] = v
  return registrySchema(t).safeParse(raw)
}

/** Echoed back so the dialog keeps what was typed (never the password). */
function echo(formData: FormData) {
  const values: Record<string, string> = {}
  for (const k of ["name", "address", "username"]) values[k] = String(formData.get(k) ?? "")
  return values
}

/** Logs in through the current environment's daemon; a failure becomes a field error. */
async function verifyLogin(api: DockerApi, cred: RegistryCredentials, { t, format }: I18n) {
  try {
    await api.registryLogin(cred)
  } catch (err) {
    throw new UserError(format(t.registries.errors.loginFailed, { address: cred.address, message: (err as Error).message }))
  }
}

export async function createRegistry(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const i18n = await getI18n()
  const { t, format } = i18n
  const parsed = parseForm(formData, t)
  if (!parsed.success) return { ...fieldErrors(parsed.error), values: echo(formData) }
  const v = parsed.data
  if (!v.password) return { error: t.common.errors.fixFields, fieldErrors: { password: [t.registries.errors.passwordRequired] }, values: echo(formData) }

  const res = await runAction("admin", "registry.create", v.address, async ({ docker }) => {
    if (await findRegistryByAddress(v.address)) throw new UserError(format(t.registries.errors.exists, { address: v.address }))
    if (v.verify === "on") await verifyLogin(await docker(), { address: v.address, username: v.username, password: v.password }, i18n)
    await insertRegistry({ name: v.name, address: v.address, username: v.username, password: v.password })
    return format(t.registries.added, { name: v.name })
  })
  return res.ok ? res : { ...res, values: echo(formData) }
}

export async function updateRegistry(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const i18n = await getI18n()
  const { t, format } = i18n
  const id = idSchema.safeParse(formData.get("id"))
  if (!id.success) return { error: t.registries.errors.invalid }
  const parsed = parseForm(formData, t)
  if (!parsed.success) return { ...fieldErrors(parsed.error), values: echo(formData) }
  const v = parsed.data

  const res = await runAction("admin", "registry.update", v.address, async ({ docker }) => {
    const other = await findRegistryByAddress(v.address)
    if (other && other.id !== id.data) throw new UserError(format(t.registries.errors.addressInUse, { name: other.name, address: v.address }))
    let stored: RegistryCredentials | null
    try {
      stored = await getRegistryCredentials(id.data)
    } catch (err) {
      if (!(err instanceof SecretDecryptError) || v.password) throw err
      throw new UserError(t.registries.errors.cannotDecrypt)
    }
    if (!stored) throw new UserError(t.registries.errors.notFound)
    // An empty password field keeps the stored one.
    const password = v.password || stored.password
    if (v.verify === "on") await verifyLogin(await docker(), { address: v.address, username: v.username, password }, i18n)
    await updateRegistryRecord(id.data, {
      name: v.name,
      address: v.address,
      username: v.username,
      password: v.password ? v.password : undefined,
    })
    return format(t.registries.saved, { name: v.name })
  })
  return res.ok ? res : { ...res, values: echo(formData) }
}

/** Registry address for the audit log (falls back to the id). Not an authorization check. */
async function registryLabel(id: number) {
  return (await listRegistries()).find((r) => r.id === id)?.address ?? `#${id}`
}

export async function deleteRegistry(id: number): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: t.registries.errors.invalid }
  return runAction("admin", "registry.delete", await registryLabel(parsed.data), async () => {
    await deleteRegistryRecord(parsed.data)
    return t.registries.removed
  })
}

/** Tries the stored login against the registry (through the current environment). */
export async function testRegistry(id: number): Promise<ActionState> {
  const i18n = await getI18n()
  const { t, format } = i18n
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: t.registries.errors.invalid }
  return runAction("admin", "registry.test", await registryLabel(parsed.data), async ({ docker }) => {
    let cred: RegistryCredentials | null
    try {
      cred = await getRegistryCredentials(parsed.data)
    } catch (err) {
      if (err instanceof SecretDecryptError) throw new UserError(err.message)
      throw err
    }
    if (!cred) throw new UserError(t.registries.errors.notFound)
    await verifyLogin(await docker(), cred, i18n)
    return format(t.registries.loggedIn, { address: cred.address, username: cred.username })
  })
}
