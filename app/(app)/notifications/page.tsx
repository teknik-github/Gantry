import type { Metadata } from "next"

import { AlertsTable, ChannelsTable, ResourceThresholds } from "@/components/gantry/notifications-ui"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { channelFields, channelTarget, CHANNEL_TYPES } from "@/lib/notifications"
import { requireAdmin } from "@/lib/server/auth/dal"
import { listChannels, recentAlerts } from "@/lib/server/notifications"
import { getThresholds } from "@/lib/server/thresholds"
import { getI18n } from "@/lib/i18n/server"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.notifications }
}

export default async function NotificationsPage() {
  await requireAdmin()
  const [channels, alerts, thresholds] = await Promise.all([listChannels(), recentAlerts(), getThresholds()])
  const { t, timeAgo } = await getI18n()
  const typeLabels: Partial<Record<string, string>> = t.notifications.typeLabels

  return (
    <PageBody>
      <PageHeader
        title={t.nav.pages.notifications}
        description={t.notifications.description}
      />
      <ChannelsTable
        data={channels.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          typeLabel: typeLabels[c.type] ?? CHANNEL_TYPES[c.type].label,
          target: channelTarget(c.type, c.config),
          events: c.events,
          enabled: c.enabled,
          // Only non-secret settings go to the browser (for the edit form).
          publicConfig: Object.fromEntries(
            channelFields(c.type)
              .filter((f) => !("secret" in f && f.secret))
              .map((f) => [f.name, c.config[f.name] ?? ""])
          ),
        }))}
      />
      <ResourceThresholds thresholds={thresholds} />
      <PageHeader title={t.notifications.alerts.title} description={t.notifications.alerts.description} />
      <AlertsTable
        data={alerts.map((a) => ({
          id: a.id,
          time: a.created_at,
          timeLabel: timeAgo(a.created_at),
          environment: a.environment_name,
          kind: a.kind,
          subject: a.subject,
          message: a.message,
          delivery: a.delivery,
        }))}
      />
    </PageBody>
  )
}
