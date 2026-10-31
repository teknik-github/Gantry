"use server"

import { headers } from "next/headers"
import { z } from "zod"

import { authorize, runAction, UserError } from "@/lib/server/action"
import { agentImage, agentRunCommand, gantryPublicUrl, needsInsecure } from "@/lib/server/agent/command"
import { agentStatus, disconnectAgent } from "@/lib/server/agent/hub"
import { generateAgentKey, hashAgentKey } from "@/lib/server/agent/keys"
import { agentUrl } from "@/lib/server/agent/state"
import { getDb } from "@/lib/server/db"
import { fieldErrors, type ActionState } from "@/lib/validation"

/** Shown once after adding an agent environment or rotating its key. */
export type AgentEnrollment = {
  id: number
  name: string
  key: string
  url: string
  command: string
  /** The agent refuses this URL (plain http to another host) without GANTRY_AGENT_INSECURE=1. */
  insecure: boolean
}

export type AgentEnrollmentState = ActionState & { enrollment?: AgentEnrollment }

const nameSchema = z.object({ name: z.string().trim().min(1, "Name is required").max(100) })
const idSchema = z.number().int().positive()

async function enrollment(id: number, name: string, key: string): Promise<AgentEnrollment> {
  const url = gantryPublicUrl(await headers())
  return { id, name, key, url, command: agentRunCommand({ url, key, image: agentImage() }), insecure: needsInsecure(url) }
}

/** Adds an "agent" environment and returns its enrollment key (stored only as a hash). */
export async function createAgentEnvironment(_prev: AgentEnrollmentState, formData: FormData): Promise<AgentEnrollmentState> {
  const parsed = nameSchema.safeParse({ name: formData.get("name") ?? "" })
  if (!parsed.success) return fieldErrors(parsed.error)
  const { name } = parsed.data

  let result: AgentEnrollment | undefined
  const res = await runAction("admin", "environment.create", `${name} (agent)`, async () => {
    const db = await getDb()
    const now = new Date().toISOString()
    // The url names the environment's id, which is only known after the insert.
    const inserted = await db
      .insertInto("environments")
      .values({ name, type: "agent", url: "agent://pending", created_at: now })
      .executeTakeFirstOrThrow()
    const id = Number(inserted.insertId)
    const key = generateAgentKey(id)
    await db
      .updateTable("environments")
      .set({ url: agentUrl(id), agent_key_hash: hashAgentKey(key), agent_key_created_at: now })
      .where("id", "=", id)
      .execute()
    result = await enrollment(id, name, key)
    return `Environment "${name}" added; start the agent on the host`
  })
  return { ...res, enrollment: res.ok ? result : undefined }
}

/** Issues a new key; the old one stops working and its agent is disconnected right away. */
export async function rotateAgentKey(id: number): Promise<AgentEnrollmentState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid environment" }

  let result: AgentEnrollment | undefined
  const res = await runAction("admin", "environment.agent_key_rotate", String(parsed.data), async () => {
    const db = await getDb()
    const env = await db.selectFrom("environments").select(["id", "name", "type"]).where("id", "=", parsed.data).executeTakeFirst()
    if (!env || env.type !== "agent") throw new UserError("Agent environment not found")
    const key = generateAgentKey(env.id)
    await db
      .updateTable("environments")
      .set({ agent_key_hash: hashAgentKey(key), agent_key_created_at: new Date().toISOString() })
      .where("id", "=", env.id)
      .execute()
    disconnectAgent(env.id, "the agent key was rotated; run the agent with the new key")
    result = await enrollment(env.id, env.name, key)
    return `New key for "${env.name}"; the old agent was disconnected`
  })
  return { ...res, enrollment: res.ok ? result : undefined }
}

export type AgentConnection = {
  connected: boolean
  hostname: string | null
  dockerVersion: string | null
}

/** Polled by the enrollment dialog while it waits for the agent to connect. */
export async function agentConnection(id: number): Promise<AgentConnection | null> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return null
  const auth = await authorize("admin")
  if ("error" in auth) return null
  const s = agentStatus(parsed.data)
  return { connected: s.connected, hostname: s.info?.hostname ?? null, dockerVersion: s.info?.dockerVersion ?? null }
}
