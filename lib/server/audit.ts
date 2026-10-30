import "server-only"

import { getDb } from "@/lib/server/db"
import type { CurrentUser } from "@/lib/server/auth/dal"

/** Who did it: a signed-in user, or a background task such as the auto-updater. */
export type Actor = Pick<CurrentUser, "username"> & { id: number | null; role?: CurrentUser["role"] }

export const SYSTEM_ACTOR = (task: string): Actor => ({ id: null, username: task })

export async function audit(user: Actor | null, action: string, target: string) {
  try {
    const db = await getDb()
    await db
      .insertInto("audit_logs")
      .values({
        user_id: user?.id ?? null,
        username: user?.username ?? "anonymous",
        action,
        target: target.slice(0, 255),
        created_at: new Date().toISOString(),
      })
      .execute()
  } catch (err) {
    // Auditing must never break the action itself.
    console.error("[gantry] failed to write audit log", err)
  }
}
