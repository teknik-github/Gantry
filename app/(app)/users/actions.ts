"use server"

import { z } from "zod"

import { runAction, UserError } from "@/lib/server/action"
import { hashPassword } from "@/lib/server/auth/password"
import { getDb } from "@/lib/server/db"
import {
  fieldErrors,
  passwordSchema,
  roleSchema,
  usernameSchema,
  type ActionState,
} from "@/lib/validation"

const idSchema = z.number().int().positive()

async function adminCount() {
  const db = await getDb()
  const row = await db
    .selectFrom("users")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("role", "=", "admin")
    .executeTakeFirstOrThrow()
  return Number(row.n)
}

export async function createUser(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ username: usernameSchema, password: passwordSchema, role: roleSchema })
    .safeParse(Object.fromEntries(formData))
  if (!parsed.success) return fieldErrors(parsed.error)
  const { username, password, role } = parsed.data

  return runAction("admin", "user.create", username, async () => {
    const db = await getDb()
    const exists = await db.selectFrom("users").select("id").where("username", "=", username).executeTakeFirst()
    if (exists) throw new UserError(`User "${username}" already exists`)
    await db
      .insertInto("users")
      .values({ username, password_hash: await hashPassword(password), role, created_at: new Date().toISOString() })
      .execute()
    return `User ${username} created`
  })
}

export async function deleteUser(id: number): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid user" }

  return runAction("admin", "user.delete", String(id), async ({ user }) => {
    if (user.id === parsed.data) throw new UserError("You cannot delete your own account")
    const db = await getDb()
    await db.deleteFrom("users").where("id", "=", parsed.data).execute()
    return "User deleted"
  })
}

export async function setUserRole(id: number, role: "admin" | "user"): Promise<ActionState> {
  const parsed = z.object({ id: idSchema, role: roleSchema }).safeParse({ id, role })
  if (!parsed.success) return { error: "Invalid request" }

  return runAction("admin", "user.role", `${id}:${role}`, async ({ user }) => {
    if (user.id === parsed.data.id && parsed.data.role !== "admin" && (await adminCount()) <= 1) {
      throw new UserError("At least one administrator is required")
    }
    const db = await getDb()
    await db.updateTable("users").set({ role: parsed.data.role }).where("id", "=", parsed.data.id).execute()
    return "Role updated"
  })
}

export async function resetPassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ id: z.coerce.number().int().positive(), password: passwordSchema })
    .safeParse(Object.fromEntries(formData))
  if (!parsed.success) return fieldErrors(parsed.error)

  return runAction("admin", "user.reset_password", String(parsed.data.id), async () => {
    const db = await getDb()
    await db
      .updateTable("users")
      .set({ password_hash: await hashPassword(parsed.data.password) })
      .where("id", "=", parsed.data.id)
      .execute()
    return "Password updated"
  })
}
