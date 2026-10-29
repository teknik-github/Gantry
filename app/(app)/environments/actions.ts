"use server"

import { cookies } from "next/headers"
import { refresh } from "next/cache"
import { z } from "zod"

import { runAction, UserError } from "@/lib/server/action"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { ENV_COOKIE } from "@/lib/server/auth/token"
import { getDb } from "@/lib/server/db"
import { docker } from "@/lib/server/docker/api"
import { fieldErrors, type ActionState } from "@/lib/validation"

const idSchema = z.number().int().positive()

export async function selectEnvironment(id: number): Promise<ActionState> {
  const user = await getCurrentUser()
  if (!user) return { error: "Your session has expired. Please sign in again." }
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid environment" }

  const db = await getDb()
  const env = await db.selectFrom("environments").select("id").where("id", "=", parsed.data).executeTakeFirst()
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

const envSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    type: z.enum(["socket", "tcp"]),
    url: z.string().trim().min(1, "Address is required").max(255),
  })
  .superRefine((v, ctx) => {
    if (v.type === "socket" && !v.url.startsWith("/")) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "Use an absolute socket path, e.g. /var/run/docker.sock" })
    }
    if (v.type === "tcp" && !/^(tcp:\/\/|http:\/\/)?[a-zA-Z0-9.-]+:\d{1,5}$/.test(v.url)) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "Use host:port, e.g. 10.0.0.5:2375" })
    }
  })

export async function createEnvironment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = envSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return fieldErrors(parsed.error)
  const { name, type, url } = parsed.data

  return runAction("admin", "environment.create", name, async () => {
    // Refuse to save an endpoint we cannot talk to.
    try {
      await docker({ type, url }).ping()
    } catch (err) {
      throw new UserError(`Could not connect: ${(err as Error).message}`)
    }
    const db = await getDb()
    await db
      .insertInto("environments")
      .values({ name, type, url, created_at: new Date().toISOString() })
      .execute()
    return `Environment "${name}" added`
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
    await db.deleteFrom("environments").where("id", "=", parsed.data).execute()
    return "Environment removed"
  })
}
