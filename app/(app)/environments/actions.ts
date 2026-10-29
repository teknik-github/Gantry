"use server"

import { cookies } from "next/headers"
import { refresh } from "next/cache"
import { z } from "zod"

import { runAction, UserError } from "@/lib/server/action"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { ENV_COOKIE } from "@/lib/server/auth/token"
import { getDb } from "@/lib/server/db"
import { docker } from "@/lib/server/docker/api"
import type { DockerTarget, DockerTls } from "@/lib/server/docker/client"
import { setEnvironmentUsers } from "@/lib/server/environment-access"
import { decryptTls, encryptTls, parseTls } from "@/lib/server/environment-target"
import { listEnvironments } from "@/lib/server/environments"
import { fieldErrors, type ActionState } from "@/lib/validation"

const idSchema = z.number().int().positive()

export async function selectEnvironment(id: number): Promise<ActionState> {
  const user = await getCurrentUser()
  if (!user) return { error: "Your session has expired. Please sign in again." }
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid environment" }

  // Only environments this user may use; others look like they don't exist.
  const env = (await listEnvironments()).find((e) => e.id === parsed.data)
  if (!env) return { error: "Environment not found" }

  ;(await cookies()).set(ENV_COOKIE, String(env.id), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  })
  refresh()
  return { ok: true }
}

const PEM_MAX = 64 * 1024

const envSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    type: z.enum(["socket", "tcp"]),
    url: z.string().trim().min(1, "Address is required").max(255),
    // "on" when the TLS switch is enabled (tcp only).
    tls: z.enum(["on"]).optional(),
    // Edit form: "on" when new PEM material is supplied for an environment that already has TLS.
    tls_replace: z.enum(["on"]).optional(),
    tls_ca: z.string().max(PEM_MAX, "Too long").default(""),
    tls_cert: z.string().max(PEM_MAX, "Too long").default(""),
    tls_key: z.string().max(PEM_MAX, "Too long").default(""),
  })
  .superRefine((v, ctx) => {
    if (v.type === "socket" && !v.url.startsWith("/")) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "Use an absolute socket path, e.g. /var/run/docker.sock" })
    }
    if (v.type === "tcp" && !/^((tcp|http|https):\/\/)?[a-zA-Z0-9.-]+:\d{1,5}$/.test(v.url)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: v.tls ? "Use host:port, e.g. 10.0.0.5:2376" : "Use host:port, e.g. 10.0.0.5:2375",
      })
    }
  })

type EnvInput = z.infer<typeof envSchema>

function parseForm(formData: FormData) {
  const raw: Record<string, FormDataEntryValue> = {}
  for (const [k, v] of formData) if (typeof v === "string") raw[k] = v
  return envSchema.safeParse(raw)
}

/** New TLS material from the form, or a field error. Never echoes the key back. */
function tlsFromForm(v: EnvInput): { tls: DockerTls } | { state: ActionState } {
  const parsed = parseTls({ ca: v.tls_ca, cert: v.tls_cert, key: v.tls_key })
  if (parsed.errors) return { state: { error: "Please fix the TLS certificates", fieldErrors: parsed.errors } }
  return { tls: parsed.tls }
}

/** Refuse to save an endpoint we cannot talk to. */
async function ping(target: DockerTarget) {
  try {
    await docker(target).ping()
  } catch (err) {
    throw new UserError(`Could not connect: ${(err as Error).message}`)
  }
}

export async function createEnvironment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseForm(formData)
  if (!parsed.success) return fieldErrors(parsed.error)
  const v = parsed.data

  let tls: DockerTls | null = null
  if (v.type === "tcp" && v.tls) {
    const res = tlsFromForm(v)
    if ("state" in res) return res.state
    tls = res.tls
  }

  return runAction("admin", "environment.create", `${v.name}${tls ? " (tls)" : ""}`, async () => {
    await ping({ type: v.type, url: v.url, tls })
    const db = await getDb()
    // No grants: only administrators can use a new environment until access is given.
    await db
      .insertInto("environments")
      .values({ name: v.name, type: v.type, url: v.url, ...encryptTls(tls), created_at: new Date().toISOString() })
      .execute()
    return `Environment "${v.name}" added`
  })
}

export async function updateEnvironment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = idSchema.safeParse(Number(formData.get("id")))
  if (!id.success) return { error: "Invalid environment" }
  const parsed = parseForm(formData)
  if (!parsed.success) return fieldErrors(parsed.error)
  const v = parsed.data

  // TLS: "keep" the stored certificates, "set" new ones, or "off" (sockets,
  // or the switch turned off).
  const useTls = v.type === "tcp" && Boolean(v.tls)
  let replacement: DockerTls | null = null
  if (useTls && v.tls_replace) {
    const res = tlsFromForm(v)
    if ("state" in res) return res.state
    replacement = res.tls
  }

  return runAction("admin", "environment.update", `${id.data}:${v.name}`, async () => {
    const db = await getDb()
    const existing = await db.selectFrom("environments").selectAll().where("id", "=", id.data).executeTakeFirst()
    if (!existing) throw new UserError("Environment not found")

    let tls: DockerTls | null = null
    if (useTls) {
      tls = replacement ?? decryptTls(existing)
      if (!tls) throw new UserError("Paste the TLS certificates to enable TLS")
    }

    await ping({ type: v.type, url: v.url, tls })
    const tlsChanged = replacement !== null || (!useTls && existing.tls_key !== null)
    await db
      .updateTable("environments")
      .set({ name: v.name, type: v.type, url: v.url, ...(tlsChanged ? encryptTls(tls) : {}) })
      .where("id", "=", id.data)
      .execute()
    return `Environment "${v.name}" saved`
  })
}

export async function deleteEnvironment(id: number): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid environment" }

  return runAction("admin", "environment.delete", String(id), async () => {
    const db = await getDb()
    const count = await db
      .selectFrom("environments")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow()
    if (Number(count.n) <= 1) throw new UserError("At least one environment is required")
    // environment_access rows go with it (ON DELETE CASCADE).
    await db.deleteFrom("environments").where("id", "=", parsed.data).execute()
    return "Environment removed"
  })
}

/** Sets which standard users may use an environment (checkboxes named "user"). */
export async function setEnvironmentAccess(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({
      id: z.coerce.number().int().positive(),
      users: z.array(z.coerce.number().int().positive()).max(10_000),
    })
    .safeParse({ id: formData.get("id"), users: formData.getAll("user") })
  if (!parsed.success) return { error: "Invalid request" }
  const { id, users } = parsed.data

  return runAction("admin", "environment.access", `${id}: ${users.join(",") || "admins only"}`, async () => {
    const db = await getDb()
    const env = await db.selectFrom("environments").select("name").where("id", "=", id).executeTakeFirst()
    if (!env) throw new UserError("Environment not found")
    await setEnvironmentUsers(db, id, users)
    return `Access to "${env.name}" updated`
  })
}
