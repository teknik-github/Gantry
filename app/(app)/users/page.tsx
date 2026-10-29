import type { Metadata } from "next"

import { UsersTable } from "@/components/gantry/admin-tables"
import { PageBody, PageHeader } from "@/components/gantry/ui"
import { timeAgo } from "@/lib/format"
import { requireAdmin } from "@/lib/server/auth/dal"
import { getDb } from "@/lib/server/db"

export const metadata: Metadata = { title: "Users" }

export default async function UsersPage() {
  const me = await requireAdmin()
  const db = await getDb()
  const users = await db
    .selectFrom("users")
    .select(["id", "username", "role", "created_at"])
    .orderBy("username")
    .execute()

  return (
    <PageBody>
      <PageHeader
        title="Users"
        description="Administrators have full control. Standard users can view resources and start, stop or restart containers."
      />
      <UsersTable
        data={users.map((u) => ({
          id: u.id,
          username: u.username,
          role: u.role,
          createdLabel: timeAgo(u.created_at),
          self: u.id === me.id,
        }))}
      />
    </PageBody>
  )
}
