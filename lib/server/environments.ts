import "server-only"

import { cache } from "react"
import { cookies } from "next/headers"

import { ENV_COOKIE } from "@/lib/server/auth/token"
import { getDb } from "@/lib/server/db"
import type { Environment } from "@/lib/server/db/schema"
import { docker } from "@/lib/server/docker/api"

export const listEnvironments = cache(async (): Promise<Environment[]> => {
  const db = await getDb()
  return db.selectFrom("environments").selectAll().orderBy("id").execute()
})

/** The environment selected via the env cookie, falling back to the first one. */
export const getCurrentEnvironment = cache(async (): Promise<Environment | null> => {
  const envs = await listEnvironments()
  const selected = Number((await cookies()).get(ENV_COOKIE)?.value)
  return envs.find((e) => e.id === selected) ?? envs[0] ?? null
})

/** Docker client bound to the current environment. Callers must authenticate first. */
export async function getDocker() {
  const env = await getCurrentEnvironment()
  if (!env) throw new Error("No Docker environment configured")
  return docker({ type: env.type, url: env.url })
}
