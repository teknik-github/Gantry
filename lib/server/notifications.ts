import "server-only"

import { decryptSecret, encryptSecret, SecretDecryptError } from "@/lib/server/crypto"
import { getDb } from "@/lib/server/db"
import {
  ALERT_KIND_KEYS,
  buildRequest,
  CHANNEL_TYPE_KEYS,
  type Alert,
  type AlertKind,
  type ChannelConfig,
  type ChannelType,
} from "@/lib/notifications"

// Notification channels and alert delivery. Channel settings (bot tokens,
// webhook URLs) are encrypted at rest and never sent to the browser.

const CONTEXT = "notification-config"
const SEND_TIMEOUT_MS = 10_000
const HISTORY_DAYS = 30

export type ChannelInfo = {
  id: number
  name: string
  type: ChannelType
  events: AlertKind[]
  enabled: boolean
  /** Non-secret settings only (for the edit form). */
  publicConfig: ChannelConfig
  config: ChannelConfig
}

function parseEvents(json: string): AlertKind[] {
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? ALERT_KIND_KEYS.filter((k) => list.includes(k)) : []
  } catch {
    return []
  }
}

function decryptConfig(value: string): ChannelConfig {
  try {
    return JSON.parse(decryptSecret(value, CONTEXT)) as ChannelConfig
  } catch (err) {
    if (err instanceof SecretDecryptError) return {}
    throw err
  }
}

/** All channels with decrypted settings (server only). */
export async function listChannels(): Promise<ChannelInfo[]> {
  const db = await getDb()
  const rows = await db.selectFrom("notification_channels").selectAll().orderBy("name").execute()
  return rows
    .filter((r) => (CHANNEL_TYPE_KEYS as string[]).includes(r.type))
    .map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type as ChannelType,
      events: parseEvents(r.events),
      enabled: r.enabled === 1,
      config: decryptConfig(r.config),
      publicConfig: {},
    }))
}

export async function getChannel(id: number) {
  return (await listChannels()).find((c) => c.id === id) ?? null
}

type ChannelValues = { name: string; type: ChannelType; config: ChannelConfig; events: AlertKind[]; enabled: boolean }

function columns(v: ChannelValues) {
  return {
    name: v.name,
    type: v.type,
    config: encryptSecret(JSON.stringify(v.config), CONTEXT),
    events: JSON.stringify(v.events),
    enabled: v.enabled ? 1 : 0,
  }
}

export async function insertChannel(v: ChannelValues) {
  const db = await getDb()
  const now = new Date().toISOString()
  const res = await db
    .insertInto("notification_channels")
    .values({ ...columns(v), created_at: now, updated_at: now })
    .executeTakeFirstOrThrow()
  return Number(res.insertId)
}

export async function updateChannel(id: number, v: ChannelValues) {
  const db = await getDb()
  await db
    .updateTable("notification_channels")
    .set({ ...columns(v), updated_at: new Date().toISOString() })
    .where("id", "=", id)
    .execute()
}

export async function deleteChannel(id: number) {
  const db = await getDb()
  await db.deleteFrom("notification_channels").where("id", "=", id).execute()
}

/** Sends one alert to one channel; resolves to an error message or null. */
export async function deliver(channel: Pick<ChannelInfo, "type" | "config">, alert: Alert): Promise<string | null> {
  try {
    const req = buildRequest(channel.type, channel.config, alert)
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
    if (res.ok) return null
    const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200)
    return `${res.status} ${res.statusText}${detail ? `: ${detail}` : ""}`
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } }
    return e.name === "TimeoutError" ? "timed out" : (e.cause?.code ?? e.message ?? "failed")
  }
}

/**
 * Raises an alert: delivers it to every enabled channel subscribed to its
 * kind and records it in the history. Never throws.
 */
export async function notify(alert: Omit<Alert, "time">, environmentId: number | null = null) {
  const full: Alert = { ...alert, time: new Date().toISOString() }
  try {
    const channels = (await listChannels()).filter((c) => c.enabled && c.events.includes(alert.kind as AlertKind))
    const failures: string[] = []
    await Promise.all(
      channels.map(async (c) => {
        const error = await deliver(c, full)
        if (error) failures.push(`${c.name}: ${error}`)
      })
    )
    const delivery = !channels.length
      ? "no channel"
      : failures.length
        ? `${channels.length - failures.length} of ${channels.length} sent; ${failures.join("; ")}`
        : `${channels.length} sent`
    if (failures.length) console.warn(`[gantry] alert "${alert.subject}": ${failures.join("; ")}`)
    const db = await getDb()
    await db
      .insertInto("alerts")
      .values({
        environment_id: environmentId,
        environment_name: alert.environment.slice(0, 100),
        kind: alert.kind,
        subject: alert.subject.slice(0, 255),
        message: alert.message.slice(0, 1000),
        delivery: delivery.slice(0, 500),
        created_at: full.time,
      })
      .execute()
  } catch (err) {
    console.error("[gantry] failed to raise alert", err)
  }
}

export async function recentAlerts(limit = 100) {
  const db = await getDb()
  return db.selectFrom("alerts").selectAll().orderBy("created_at", "desc").orderBy("id", "desc").limit(limit).execute()
}

export async function pruneAlerts(days = HISTORY_DAYS) {
  const db = await getDb()
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  await db.deleteFrom("alerts").where("created_at", "<", cutoff).execute()
}
