import "server-only"

import crypto from "node:crypto"
import type { Kysely } from "kysely"

import type { Database, Role } from "@/lib/server/db/schema"

// Personal API tokens for automation: "gtk_" + 32 random bytes (base64url).
// Only a SHA-256 hash is stored (the token has 256 bits of entropy, so a slow
// hash adds nothing), plus the first characters to tell tokens apart. They
// authenticate /api/* route handlers only, never pages or Server Actions
// (see proxy.ts and lib/server/auth/dal.ts).

export const TOKEN_PREFIX = "gtk_"
const TOKEN_BYTES = 32
const TOKEN_RE = /^gtk_[A-Za-z0-9_-]{43}$/
/** Characters of the token shown in the list ("gtk_" + 6). */
const DISPLAY_PREFIX_LENGTH = 10
/** last_used_at is only written when older than this, to spare the database. */
const LAST_USED_RESOLUTION_MS = 60_000
export const MAX_TOKENS_PER_USER = 50

export function generateApiToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString("base64url")
}

/** Whether `value` looks like a Gantry API token (format only). */
export function isApiTokenFormat(value: string): boolean {
  return TOKEN_RE.test(value)
}

export function hashApiToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex")
}

/** The token from an "Authorization: Bearer gtk_..." header, or null. */
export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer[ ]+(\S+)\s*$/i.exec(header ?? "")
  return m && isApiTokenFormat(m[1]) ? m[1] : null
}

export type ApiTokenRow = {
  id: number
  name: string
  prefix: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
}

export async function listApiTokens(db: Kysely<Database>, userId: number): Promise<ApiTokenRow[]> {
  return db
    .selectFrom("api_tokens")
    .select(["id", "name", "prefix", "created_at", "expires_at", "last_used_at"])
    .where("user_id", "=", userId)
    .orderBy("id", "desc")
    .execute()
}

/** Creates a token and returns it; this is the only time it is available in clear text. */
export async function createApiToken(
  db: Kysely<Database>,
  userId: number,
  name: string,
  expiresAt: Date | null
): Promise<string> {
  const token = generateApiToken()
  await db
    .insertInto("api_tokens")
    .values({
      user_id: userId,
      name,
      token_hash: hashApiToken(token),
      prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
      created_at: new Date().toISOString(),
      expires_at: expiresAt?.toISOString() ?? null,
    })
    .execute()
  return token
}

/** Deletes one of the user's tokens. Returns its name, or null if it isn't theirs. */
export async function revokeApiToken(db: Kysely<Database>, userId: number, id: number): Promise<string | null> {
  const row = await db.selectFrom("api_tokens").select("name").where("id", "=", id).where("user_id", "=", userId).executeTakeFirst()
  if (!row) return null
  await db.deleteFrom("api_tokens").where("id", "=", id).where("user_id", "=", userId).execute()
  return row.name
}

/**
 * The user a token belongs to, if it exists and hasn't expired. Records when
 * it was last used (at most once a minute).
 */
export async function authenticateApiToken(
  db: Kysely<Database>,
  token: string,
  now: Date = new Date()
): Promise<{ id: number; username: string; role: Role } | null> {
  if (!isApiTokenFormat(token)) return null
  const row = await db
    .selectFrom("api_tokens")
    .innerJoin("users", "users.id", "api_tokens.user_id")
    .select([
      "api_tokens.id as token_id",
      "api_tokens.expires_at",
      "api_tokens.last_used_at",
      "users.id",
      "users.username",
      "users.role",
    ])
    .where("api_tokens.token_hash", "=", hashApiToken(token))
    .executeTakeFirst()
  if (!row) return null
  if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) return null
  if (!row.last_used_at || now.getTime() - Date.parse(row.last_used_at) > LAST_USED_RESOLUTION_MS) {
    await db.updateTable("api_tokens").set({ last_used_at: now.toISOString() }).where("id", "=", row.token_id).execute()
  }
  return { id: row.id, username: row.username, role: row.role }
}
