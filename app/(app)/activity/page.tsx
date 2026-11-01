import type { Metadata } from "next"

import { ActivityTable } from "@/components/gantry/activity-table"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { requireAdmin } from "@/lib/server/auth/dal"
import { getDb } from "@/lib/server/db"
import { getI18n } from "@/lib/i18n/server"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.activity }
}

const LIMIT = 1000

export default async function ActivityPage() {
  await requireAdmin()
  const db = await getDb()
  const logs = await db
    .selectFrom("audit_logs")
    .selectAll()
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(LIMIT)
    .execute()
  const { t, format, formatDate } = await getI18n()

  return (
    <PageBody>
      <PageHeader title={t.nav.pages.activity} description={format(t.activity.description, { limit: LIMIT })} />
      <ActivityTable
        data={logs.map((l) => ({
          id: l.id,
          username: l.username,
          action: l.action,
          target: l.target,
          at: l.created_at,
          atLabel: formatDate(l.created_at),
        }))}
      />
    </PageBody>
  )
}
