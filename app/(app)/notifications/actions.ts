"use server"

import { z } from "zod"

import { ALERT_KIND_KEYS, CHANNEL_TYPE_KEYS, checkChannelConfig, channelFields, type AlertKind, type ChannelType } from "@/lib/notifications"
import { runAction, UserError } from "@/lib/server/action"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { deleteChannel as deleteChannelRecord, deliver, getChannel, insertChannel, updateChannel as updateChannelRecord } from "@/lib/server/notifications"
import type { ActionState } from "@/lib/validation"

const idSchema = z.coerce.number().int().positive()

/** Validates the channel form; on edit, empty secret fields keep the stored values. */
async function parseChannel(formData: FormData, previous?: Awaited<ReturnType<typeof getChannel>>) {
  const name = String(formData.get("name") ?? "").trim()
  const type = String(formData.get("type") ?? "") as ChannelType
  const fieldErrors: Record<string, string[]> = {}
  if (!name) fieldErrors.name = ["Name is required"]
  else if (name.length > 100) fieldErrors.name = ["At most 100 characters"]
  if (!CHANNEL_TYPE_KEYS.includes(type)) return { state: { error: "Pick a channel type" } as ActionState }
  if (previous && previous.type !== type) return { state: { error: "The channel type can't be changed" } as ActionState }

  const submitted: Record<string, string> = {}
  for (const f of channelFields(type)) submitted[f.name] = String(formData.get(`cfg:${f.name}`) ?? "")
  const { config, errors } = checkChannelConfig(type, submitted, previous?.config)
  for (const [k, msg] of Object.entries(errors)) fieldErrors[`cfg:${k}`] = [msg]
  const events = formData.getAll("events").map(String).filter((e): e is AlertKind => (ALERT_KIND_KEYS as string[]).includes(e))
  if (!events.length) fieldErrors.events = ["Pick at least one alert"]
  if (Object.keys(fieldErrors).length) return { state: { error: "Please fix the highlighted fields", fieldErrors } as ActionState }
  return { data: { name, type, config, events, enabled: formData.get("enabled") === "on" } }
}

export async function createChannel(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = await parseChannel(formData)
  if (parsed.state) return parsed.state
  const v = parsed.data
  return runAction("admin", "notification.create", v.name, async () => {
    await insertChannel(v)
    return `Channel ${v.name} added`
  })
}

export async function updateChannel(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = idSchema.safeParse(formData.get("id"))
  if (!id.success) return { error: "Invalid channel" }
  // Validation needs the stored settings, so check the role before reading them.
  if ((await getCurrentUser())?.role !== "admin") return { error: "Only administrators can do this." }
  const previous = await getChannel(id.data)
  if (!previous) return { error: "Channel not found" }
  const parsed = await parseChannel(formData, previous)
  if (parsed.state) return parsed.state
  const v = parsed.data
  return runAction("admin", "notification.update", v.name, async () => {
    await updateChannelRecord(id.data, v)
    return `Channel ${v.name} saved`
  })
}

export async function deleteChannel(id: number): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid channel" }
  return runAction("admin", "notification.delete", `#${parsed.data}`, async () => {
    await deleteChannelRecord(parsed.data)
    return "Channel removed"
  })
}

export async function setChannelEnabled(id: number, enabled: boolean): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid channel" }
  return runAction("admin", enabled ? "notification.enable" : "notification.disable", `#${parsed.data}`, async () => {
    const c = await getChannel(parsed.data)
    if (!c) throw new UserError("Channel not found")
    await updateChannelRecord(c.id, { ...c, enabled: enabled === true })
    return `${c.name} ${enabled ? "enabled" : "paused"}`
  })
}

export async function testChannel(id: number): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid channel" }
  return runAction("admin", "notification.test", `#${parsed.data}`, async () => {
    const c = await getChannel(parsed.data)
    if (!c) throw new UserError("Channel not found")
    if (!Object.keys(c.config).length) throw new UserError("Its settings can't be decrypted (the Gantry secret changed). Edit it and enter them again.")
    const error = await deliver(c, {
      kind: "test",
      environment: "test",
      subject: "Test notification",
      message: "If you can read this, Gantry can reach this channel.",
      time: new Date().toISOString(),
    })
    if (error) throw new UserError(`${c.name}: ${error}`)
    return `Test sent to ${c.name}`
  })
}
