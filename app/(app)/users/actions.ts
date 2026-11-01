"use server"

import { z } from "zod"

import { runAction, UserError } from "@/lib/server/action"
import { hashPassword } from "@/lib/server/auth/password"
import { disableTwoFactor } from "@/lib/server/auth/two-factor"
import { getDb } from "@/lib/server/db"
import { getI18n } from "@/lib/i18n/server"
import { closeUserExecSessions } from "@/lib/server/docker/exec"
import { parseGrants, setUserEnvironments } from "@/lib/server/environment-access"
import { changeRole, deleteUserChecked, invalidateSessions } from "@/lib/server/users"
import {
  fieldErrors,
  passwordSchema,
  roleSchema,
  usernameSchema,
  type ActionState,
} from "@/lib/validation"

const idSchema = z.number().int().positive()

export async function createUser(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ username: usernameSchema, password: passwordSchema, role: roleSchema })
    .safeParse(Object.fromEntries(formData))
  if (!parsed.success) return fieldErrors(parsed.error)
  const { username, password, role } = parsed.data
  const { t, format } = await getI18n()

  return runAction("admin", "user.create", username, async () => {
    const db = await getDb()
    const exists = await db.selectFrom("users").select("id").where("username", "=", username).executeTakeFirst()
    if (exists) throw new UserError(format(t.users.exists, { username }))
    await db
      .insertInto("users")
      .values({ username, password_hash: await hashPassword(password), role, created_at: new Date().toISOString() })
      .execute()
    return format(t.users.created, { username })
  })
}

export async function deleteUser(id: number): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: t.users.invalidUser }

  return runAction("admin", "user.delete", String(id), async ({ user }) => {
    if (user.id === parsed.data) throw new UserError(t.users.cannotDeleteSelf)
    const result = await deleteUserChecked(await getDb(), parsed.data)
    if (result === "last_admin") throw new UserError(t.users.lastAdmin)
    if (result === "not_found") throw new UserError(t.users.notFound)
    return t.users.deleted
  })
}

/**
 * Changes a user's global role. Atomic with the "at least one administrator"
 * check; signs the user out everywhere. Promotion drops their environment
 * grants, so demoting them later starts from no access (grant it again).
 */
export async function setUserRole(id: number, role: "admin" | "user"): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = z.object({ id: idSchema, role: roleSchema }).safeParse({ id, role })
  if (!parsed.success) return { error: t.users.invalidRequest }

  return runAction("admin", "user.role", `${id}:${role}`, async () => {
    const result = await changeRole(await getDb(), parsed.data.id, parsed.data.role)
    if (result === "last_admin") throw new UserError(t.users.lastAdmin)
    if (result === "not_found") throw new UserError(t.users.notFound)
    return t.users.roleUpdated
  })
}

export async function resetPassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ id: z.coerce.number().int().positive(), password: passwordSchema })
    .safeParse(Object.fromEntries(formData))
  if (!parsed.success) return fieldErrors(parsed.error)
  const { t } = await getI18n()

  return runAction("admin", "user.reset_password", String(parsed.data.id), async () => {
    const db = await getDb()
    await db
      .updateTable("users")
      .set({ password_hash: await hashPassword(parsed.data.password) })
      .where("id", "=", parsed.data.id)
      .execute()
    // Whoever had the old password (or a session) is out.
    await invalidateSessions(db, parsed.data.id)
    return t.users.passwordUpdated
  })
}

/**
 * Turns off a user's two-factor authentication (lost device and recovery
 * codes) and signs them out everywhere. Audited as user.reset_2fa.
 */
export async function resetTwoFactor(id: number): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: t.users.invalidUser }

  return runAction("admin", "user.reset_2fa", String(id), async () => {
    const db = await getDb()
    const target = await db.selectFrom("users").select("username").where("id", "=", parsed.data).executeTakeFirst()
    if (!target) throw new UserError(t.users.notFound)
    await disableTwoFactor(db, parsed.data)
    await invalidateSessions(db, parsed.data)
    return format(t.users.twoFactorReset, { username: target.username })
  })
}

/** Sets which environments a standard user may use, and their role in each ("env" values "<id>:<role>"). */
export async function setUserAccess(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const id = z.coerce.number().int().positive().safeParse(formData.get("id"))
  const grants = parseGrants(formData.getAll("env"))
  if (!id.success || !grants || grants.length > 10_000) return { error: t.users.invalidRequest }
  const summary = grants.map((g) => `${g.id}=${g.role}`).join(",") || "none"

  return runAction("admin", "user.environments", `${id.data}: ${summary}`, async () => {
    const db = await getDb()
    const target = await db.selectFrom("users").select(["username", "role"]).where("id", "=", id.data).executeTakeFirst()
    if (!target) throw new UserError(t.users.notFound)
    if (target.role === "admin") throw new UserError(t.users.adminsUseAll)
    await setUserEnvironments(db, id.data, grants)
    // Consoles need the manager role; let them be reopened under the new grants.
    closeUserExecSessions(id.data)
    return format(t.users.accessUpdated, { username: target.username })
  })
}
