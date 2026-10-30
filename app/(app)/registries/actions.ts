"use server"

import { z } from "zod"

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

const registrySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  address: z
    .string()
    .trim()
    .min(1, "Address is required")
    .max(255)
    .transform((v, ctx) => {
      const address = normalizeRegistryAddress(v)
      if (!address) {
        ctx.addIssue({ code: "custom", message: "Use a registry host, e.g. ghcr.io or registry.example.com:5000" })
        return z.NEVER
      }
      return address
    }),
  username: z.string().trim().min(1, "Username is required").max(255),
  password: z.string().max(4096, "Too long"),
  verify: z.enum(["on"]).optional(),
})

function parseForm(formData: FormData) {
  const raw: Record<string, string> = {}
  for (const [k, v] of formData) if (typeof v === "string") raw[k] = v
  return registrySchema.safeParse(raw)
}

/** Echoed back so the dialog keeps what was typed (never the password). */
function echo(formData: FormData) {
  const values: Record<string, string> = {}
  for (const k of ["name", "address", "username"]) values[k] = String(formData.get(k) ?? "")
  return values
}

/** Logs in through the current environment's daemon; a failure becomes a field error. */
async function verifyLogin(api: DockerApi, cred: RegistryCredentials) {
  try {
    await api.registryLogin(cred)
  } catch (err) {
    throw new UserError(`Login to ${cred.address} failed: ${(err as Error).message}`)
  }
}

export async function createRegistry(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(formData)
  if (!parsed.success) return { ...fieldErrors(parsed.error), values: echo(formData) }
  const v = parsed.data
  if (!v.password) return { error: "Please fix the highlighted fields", fieldErrors: { password: ["Password or token is required"] }, values: echo(formData) }

  const res = await runAction("admin", "registry.create", v.address, async ({ docker }) => {
    if (await findRegistryByAddress(v.address)) throw new UserError(`A login for ${v.address} already exists; edit it instead`)
    if (v.verify === "on") await verifyLogin(await docker(), { address: v.address, username: v.username, password: v.password })
    await insertRegistry({ name: v.name, address: v.address, username: v.username, password: v.password })
    return `Registry ${v.name} added`
  })
  return res.ok ? res : { ...res, values: echo(formData) }
}

export async function updateRegistry(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = idSchema.safeParse(formData.get("id"))
  if (!id.success) return { error: "Invalid registry" }
  const parsed = parseForm(formData)
  if (!parsed.success) return { ...fieldErrors(parsed.error), values: echo(formData) }
  const v = parsed.data

  const res = await runAction("admin", "registry.update", v.address, async ({ docker }) => {
    const other = await findRegistryByAddress(v.address)
    if (other && other.id !== id.data) throw new UserError(`${other.name} already uses ${v.address}`)
    let stored: RegistryCredentials | null
    try {
      stored = await getRegistryCredentials(id.data)
    } catch (err) {
      if (!(err instanceof SecretDecryptError) || v.password) throw err
      throw new UserError("The stored password can't be decrypted (the Gantry secret changed). Enter it again.")
    }
    if (!stored) throw new UserError("Registry not found")
    // An empty password field keeps the stored one.
    const password = v.password || stored.password
    if (v.verify === "on") await verifyLogin(await docker(), { address: v.address, username: v.username, password })
    await updateRegistryRecord(id.data, {
      name: v.name,
      address: v.address,
      username: v.username,
      password: v.password ? v.password : undefined,
    })
    return `Registry ${v.name} saved`
  })
  return res.ok ? res : { ...res, values: echo(formData) }
}

/** Registry address for the audit log (falls back to the id). Not an authorization check. */
async function registryLabel(id: number) {
  return (await listRegistries()).find((r) => r.id === id)?.address ?? `#${id}`
}

export async function deleteRegistry(id: number): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid registry" }
  return runAction("admin", "registry.delete", await registryLabel(parsed.data), async () => {
    await deleteRegistryRecord(parsed.data)
    return "Registry removed"
  })
}

/** Tries the stored login against the registry (through the current environment). */
export async function testRegistry(id: number): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid registry" }
  return runAction("admin", "registry.test", await registryLabel(parsed.data), async ({ docker }) => {
    let cred: RegistryCredentials | null
    try {
      cred = await getRegistryCredentials(parsed.data)
    } catch (err) {
      if (err instanceof SecretDecryptError) throw new UserError(err.message)
      throw err
    }
    if (!cred) throw new UserError("Registry not found")
    await verifyLogin(await docker(), cred)
    return `Logged in to ${cred.address} as ${cred.username}`
  })
}
