"use server"

import { z } from "zod"

import { ALERT_KIND_KEYS, CHANNEL_TYPE_KEYS, checkChannelConfig, channelFields, type AlertKind, type ChannelType } from "@/lib/notifications"
import { runAction, UserError } from "@/lib/server/action"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { deleteChannel as deleteChannelRecord, deliver, getChannel, insertChannel, updateChannel as updateChannelRecord } from "@/lib/server/notifications"
import { checkThresholds } from "@/lib/thresholds"
import { saveThresholds } from "@/lib/server/thresholds"
import { getI18n } from "@/lib/i18n/server"
import type { I18n } from "@/lib/i18n"
import type { ActionState } from "@/lib/validation"

const idSchema = z.coerce.number().int().positive()

/** The English messages of checkChannelConfig() in the user's language (unknown ones as they are). */
function configError(t: I18n["t"], message: string): string {
  const e = t.notifications.configErrors
  const known: Record<string, string> = {
    "Enter it again: the destination changed": e.destinationChanged,
    Required: e.required,
    "Too long": e.tooLong,
    "Use an http(s) URL": e.httpUrl,
    "Pick one of the options": e.pickOption,
    "Letters, digits, - and _ (max 64)": e.topic,
    "A host name or IP address": e.host,
    "An email address, optionally with a name": e.from,
    "Comma-separated email addresses": e.to,
    "Required with a username": e.passwordWithUsername,
    "A numeric id or @channelname": e.chatId,
  }
  return Object.hasOwn(known, message) ? known[message] : message
}

/** Validates the channel form; on edit, empty secret fields keep the stored values. */
async function parseChannel(formData: FormData, previous?: Awaited<ReturnType<typeof getChannel>>) {
  const { t } = await getI18n()
  const name = String(formData.get("name") ?? "").trim()
  const type = String(formData.get("type") ?? "") as ChannelType
  const fieldErrors: Record<string, string[]> = {}
  if (!name) fieldErrors.name = [t.notifications.nameRequired]
  else if (name.length > 100) fieldErrors.name = [t.notifications.nameTooLong]
  if (!CHANNEL_TYPE_KEYS.includes(type)) return { state: { error: t.notifications.pickType } as ActionState }
  if (previous && previous.type !== type) return { state: { error: t.notifications.typeFixed } as ActionState }

  const submitted: Record<string, string> = {}
  for (const f of channelFields(type)) submitted[f.name] = String(formData.get(`cfg:${f.name}`) ?? "")
  const { config, errors } = checkChannelConfig(type, submitted, previous?.config)
  for (const [k, msg] of Object.entries(errors)) fieldErrors[`cfg:${k}`] = [configError(t, msg)]
  const events = formData.getAll("events").map(String).filter((e): e is AlertKind => (ALERT_KIND_KEYS as string[]).includes(e))
  if (!events.length) fieldErrors.events = [t.notifications.pickAlert]
  if (Object.keys(fieldErrors).length) return { state: { error: t.common.errors.fixFields, fieldErrors } as ActionState }
  return { data: { name, type, config, events, enabled: formData.get("enabled") === "on" } }
}

export async function createChannel(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = await parseChannel(formData)
  if (parsed.state) return parsed.state
  const v = parsed.data
  const { t, format } = await getI18n()
  return runAction("admin", "notification.create", v.name, async () => {
    await insertChannel(v)
    return format(t.notifications.added, { name: v.name })
  })
}

export async function updateChannel(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const id = idSchema.safeParse(formData.get("id"))
  if (!id.success) return { error: t.notifications.invalid }
  // Validation needs the stored settings, so check the role before reading them.
  if ((await getCurrentUser())?.role !== "admin") return { error: t.common.errors.adminsOnly }
  const previous = await getChannel(id.data)
  if (!previous) return { error: t.notifications.notFound }
  const parsed = await parseChannel(formData, previous)
  if (parsed.state) return parsed.state
  const v = parsed.data
  return runAction("admin", "notification.update", v.name, async () => {
    await updateChannelRecord(id.data, v)
    return format(t.notifications.saved, { name: v.name })
  })
}

export async function deleteChannel(id: number): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: t.notifications.invalid }
  return runAction("admin", "notification.delete", `#${parsed.data}`, async () => {
    await deleteChannelRecord(parsed.data)
    return t.notifications.removed
  })
}

export async function setChannelEnabled(id: number, enabled: boolean): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: t.notifications.invalid }
  return runAction("admin", enabled ? "notification.enable" : "notification.disable", `#${parsed.data}`, async () => {
    const c = await getChannel(parsed.data)
    if (!c) throw new UserError(t.notifications.notFound)
    await updateChannelRecord(c.id, { ...c, enabled: enabled === true })
    return format(enabled ? t.notifications.enabled : t.notifications.paused, { name: c.name })
  })
}

export async function testChannel(id: number): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: t.notifications.invalid }
  return runAction("admin", "notification.test", `#${parsed.data}`, async () => {
    const c = await getChannel(parsed.data)
    if (!c) throw new UserError(t.notifications.notFound)
    if (!Object.keys(c.config).length) throw new UserError(t.notifications.undecryptable)
    const error = await deliver(c, {
      kind: "test",
      environment: "test",
      subject: "Test notification",
      message: "If you can read this, Gantry can reach this channel.",
      time: new Date().toISOString(),
    })
    if (error) throw new UserError(`${c.name}: ${error}`)
    return format(t.notifications.testSent, { name: c.name })
  })
}

export async function saveResourceThresholds(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const i18n = await getI18n()
  const values: Record<string, string> = {}
  for (const k of ["containerCpu", "containerMemory", "hostMemory", "minutes"]) values[k] = String(formData.get(k) ?? "")
  const checked = checkThresholds(values)
  if (!checked.thresholds) {
    return {
      error: i18n.t.common.errors.fixFields,
      fieldErrors: Object.fromEntries(Object.entries(checked.errors).map(([k, v]) => [k, [v]])),
      values,
    }
  }
  const t = checked.thresholds
  const summary = [
    t.containerCpu !== null ? `CPU ${t.containerCpu}%` : null,
    t.containerMemory !== null ? `memory ${t.containerMemory}%` : null,
    t.hostMemory !== null ? `host memory ${t.hostMemory}%` : null,
  ].filter(Boolean)
  // The audit entry stays English; the message is in the user's language.
  const m = i18n.t.notifications
  const shown = [
    t.containerCpu !== null ? i18n.format(m.cpu, { value: t.containerCpu }) : null,
    t.containerMemory !== null ? i18n.format(m.memory, { value: t.containerMemory }) : null,
    t.hostMemory !== null ? i18n.format(m.hostMemoryValue, { value: t.hostMemory }) : null,
  ].filter(Boolean)
  return runAction("admin", "notification.thresholds", summary.join(", ") || "off", async () => {
    await saveThresholds(t)
    return shown.length ? i18n.format(m.thresholdsSaved, { summary: shown.join(", "), minutes: t.minutes }) : m.thresholdsOff
  })
}
