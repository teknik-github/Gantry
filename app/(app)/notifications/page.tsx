import type { Metadata } from "next"

import { AlertsTable, ChannelsTable, ResourceThresholds } from "@/components/gantry/notifications-ui"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { timeAgo } from "@/lib/format"
import { channelFields, channelTarget, CHANNEL_TYPES } from "@/lib/notifications"
import { requireAdmin } from "@/lib/server/auth/dal"
import { listChannels, recentAlerts } from "@/lib/server/notifications"
import { getThresholds } from "@/lib/server/thresholds"

export const metadata: Metadata = { title: "Notifications" }

export default async function NotificationsPage() {
  await requireAdmin()
  const [channels, alerts, thresholds] = await Promise.all([listChannels(), recentAlerts(), getThresholds()])

  return (
    <PageBody>
      <PageHeader
        title="Notifications"
        description="Where Gantry sends alerts: crashed, out-of-memory, unhealthy or restarting containers, unreachable environments, image updates and auto-update results."
      />
      <ChannelsTable
        data={channels.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          typeLabel: CHANNEL_TYPES[c.type].label,
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
      <PageHeader title="Recent alerts" description="The last 100 alerts (kept for 30 days), whether or not a channel received them." />
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
