import "server-only"

import { headers } from "next/headers"

import type { CurrentUser } from "@/lib/server/auth/dal"
import { getBackupSchedule } from "@/lib/server/backup"
import { config } from "@/lib/server/config"
import { getDb } from "@/lib/server/db"
import { listChannels } from "@/lib/server/notifications"

/**
 * Things an administrator should fix before relying on Gantry, worked out
 * from the request (how Gantry is reached) and the stored settings. Only
 * the ones that need attention are returned. The texts are looked up by id
 * where they are shown (t.dashboard.setupChecks, components/gantry/setup-checks.tsx).
 */

export type SetupCheckId = "https" | "cookie" | "trust-proxy" | "backups" | "2fa" | "notifications"

export type SetupCheck = {
  id: SetupCheckId
  /** Page where it is fixed (the card shows a button to it). */
  href?: string
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i

export async function setupChecks(user: CurrentUser): Promise<SetupCheck[]> {
  const h = await headers()
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? ""
  const proto = (h.get("x-forwarded-proto") ?? "http").split(",")[0].trim().toLowerCase()
  const behindProxy = h.has("x-forwarded-for")
  const local = LOCAL_HOST.test(host)
  const checks: SetupCheck[] = []

  if (proto !== "https" && !local) {
    checks.push({ id: "https", href: "/proxy" })
  }
  if (proto === "https" && config.cookieSecure === "false") {
    checks.push({ id: "cookie" })
  }
  if (behindProxy && !config.trustProxy) {
    checks.push({ id: "trust-proxy" })
  }

  const [schedule, channels, me] = await Promise.all([
    getBackupSchedule(),
    listChannels(),
    getDb().then((db) => db.selectFrom("users").select("totp_enabled").where("id", "=", user.id).executeTakeFirst()),
  ])
  if (!schedule.enabled) {
    checks.push({ id: "backups", href: "/backups" })
  }
  if (Number(me?.totp_enabled ?? 0) !== 1) {
    checks.push({ id: "2fa", href: "/account" })
  }
  if (!channels.some((c) => c.enabled)) {
    checks.push({ id: "notifications", href: "/notifications" })
  }
  return checks
}
