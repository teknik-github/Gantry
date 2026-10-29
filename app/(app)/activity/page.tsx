import type { Metadata } from "next"

import { ActivityTable } from "@/components/gantry/admin-tables"
import { PageBody, PageHeader } from "@/components/gantry/ui"
import { formatDate } from "@/lib/format"
import { requireAdmin } from "@/lib/server/auth/dal"
import { getDb } from "@/lib/server/db"

export const metadata: Metadata = { title: "Activity" }

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

  return (
    <PageBody>
      <PageHeader title="Activity" description={`The latest ${LIMIT} actions performed in Gantry.`} />
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
