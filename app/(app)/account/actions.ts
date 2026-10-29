"use server"

import { z } from "zod"

import { runAction, UserError } from "@/lib/server/action"
import { hashPassword, verifyPassword } from "@/lib/server/auth/password"
import { getDb } from "@/lib/server/db"
import { fieldErrors, passwordSchema, type ActionState } from "@/lib/validation"

export async function changePassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ current: z.string().min(1, "Enter your current password"), password: passwordSchema, confirm: z.string() })
    .refine((d) => d.password === d.confirm, { path: ["confirm"], message: "Passwords do not match" })
    .safeParse(Object.fromEntries(formData))
  if (!parsed.success) return fieldErrors(parsed.error)

  return runAction("operate", "account.change_password", "self", async ({ user }) => {
    const db = await getDb()
    const row = await db.selectFrom("users").select("password_hash").where("id", "=", user.id).executeTakeFirstOrThrow()
    if (!(await verifyPassword(parsed.data.current, row.password_hash))) {
      throw new UserError("Current password is incorrect")
    }
    await db
      .updateTable("users")
      .set({ password_hash: await hashPassword(parsed.data.password) })
      .where("id", "=", user.id)
      .execute()
    return "Password changed"
  })
}
