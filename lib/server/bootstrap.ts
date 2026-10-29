import "server-only"

import { hasAnyUser } from "@/lib/server/auth/dal"
import { hashPassword } from "@/lib/server/auth/password"
import { getDb } from "@/lib/server/db"
import { clearSetupToken, getSetupToken, setupTokenSource } from "@/lib/server/setup-token"
import { passwordSchema, usernameSchema } from "@/lib/validation"

/**
 * First-run handling at server start: either create the admin from
 * GANTRY_ADMIN_USERNAME/GANTRY_ADMIN_PASSWORD, or print the setup token that
 * /setup asks for. Does nothing once a user exists.
 */
export async function bootstrapFirstRun() {
  if (await hasAnyUser()) {
    clearSetupToken()
    return
  }

  const username = process.env.GANTRY_ADMIN_USERNAME?.trim()
  const password = process.env.GANTRY_ADMIN_PASSWORD
  if (username || password) {
    const u = usernameSchema.safeParse(username ?? "")
    const p = passwordSchema.safeParse(password ?? "")
    if (!u.success || !p.success) {
      throw new Error(
        "GANTRY_ADMIN_USERNAME/GANTRY_ADMIN_PASSWORD are invalid (username 3-64 of [a-zA-Z0-9_.-], password >= 8 chars)"
      )
    }
    const db = await getDb()
    await db
      .insertInto("users")
      .values({
        username: u.data,
        password_hash: await hashPassword(p.data),
        role: "admin",
        created_at: new Date().toISOString(),
      })
      .execute()
    console.log(`[gantry] created administrator "${u.data}" from GANTRY_ADMIN_USERNAME`)
    return
  }

  const token = getSetupToken()
  const line = "=".repeat(64)
  console.log(
    [
      "",
      line,
      " Gantry is not set up yet. Open /setup and enter this setup token:",
      "",
      `   ${token}`,
      "",
      ` (also available in ${setupTokenSource()})`,
      line,
      "",
    ].join("\n")
  )
}
