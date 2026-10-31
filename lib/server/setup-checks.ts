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
 * the ones that need attention are returned.
 */

export type SetupCheck = {
  id: string
  title: string
  detail: string
  href?: string
  action?: string
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
    checks.push({
      id: "https",
      title: "Gantry is served over plain HTTP",
      detail:
        "Passwords and session cookies cross the network unencrypted. Put Gantry behind HTTPS, for example with the built-in proxy (Expose via proxy on Gantry's own container), and keep COOKIE_SECURE=auto.",
      href: "/proxy",
      action: "Set up the proxy",
    })
  }
  if (proto === "https" && config.cookieSecure === "false") {
    checks.push({
      id: "cookie",
      title: "Session cookies aren't marked Secure",
      detail: "COOKIE_SECURE=false lets browsers send the session over HTTP too. Set it to auto (or true).",
    })
  }
  if (behindProxy && !config.trustProxy) {
    checks.push({
      id: "trust-proxy",
      title: "Behind a proxy, but TRUST_PROXY is off",
      detail:
        "Login rate limits can't tell clients apart and fall back to per-account limits. Set TRUST_PROXY=true if the proxy in front of Gantry is yours and sets X-Forwarded-For.",
    })
  }

  const [schedule, channels, me] = await Promise.all([
    getBackupSchedule(),
    listChannels(),
    getDb().then((db) => db.selectFrom("users").select("totp_enabled").where("id", "=", user.id).executeTakeFirst()),
  ])
  if (!schedule.enabled) {
    checks.push({
      id: "backups",
      title: "No scheduled backups",
      detail: "Environment credentials, users and stacks live only in Gantry's database. Schedule a daily encrypted backup.",
      href: "/backups",
      action: "Set up backups",
    })
  }
  if (Number(me?.totp_enabled ?? 0) !== 1) {
    checks.push({
      id: "2fa",
      title: "Your account has no two-factor authentication",
      detail: "Administrators control every Docker host here; protect the account with an authenticator app.",
      href: "/account",
      action: "Turn on 2FA",
    })
  }
  if (!channels.some((c) => c.enabled)) {
    checks.push({
      id: "notifications",
      title: "Nobody gets alerts",
      detail: "Crashed containers, unreachable hosts and failed backups are only listed in Gantry. Add a channel to be told.",
      href: "/notifications",
      action: "Add a channel",
    })
  }
  return checks
}
