import "server-only"

import { decryptSecret, encryptSecret, SecretDecryptError } from "@/lib/server/crypto"
import { getDb } from "@/lib/server/db"
import { registryOf, type RegistryCredentials } from "@/lib/registry"

// Registry logins. Passwords are encrypted at rest and only ever decrypted on
// the server, right before a pull; they never reach the browser.

const CONTEXT = "registry-password"

/** A registry without its password (safe to render). */
export type RegistryInfo = { id: number; name: string; address: string; username: string; updatedAt: string }

export async function listRegistries(): Promise<RegistryInfo[]> {
  const db = await getDb()
  const rows = await db
    .selectFrom("registries")
    .select(["id", "name", "address", "username", "updated_at"])
    .orderBy("name")
    .execute()
  return rows.map((r) => ({ id: r.id, name: r.name, address: r.address, username: r.username, updatedAt: r.updated_at }))
}

export async function findRegistryByAddress(address: string) {
  const db = await getDb()
  return db.selectFrom("registries").select(["id", "name"]).where("address", "=", address).executeTakeFirst()
}

export async function insertRegistry(values: { name: string; address: string; username: string; password: string }) {
  const db = await getDb()
  const now = new Date().toISOString()
  const res = await db
    .insertInto("registries")
    .values({ ...values, password: encryptSecret(values.password, CONTEXT), created_at: now, updated_at: now })
    .executeTakeFirstOrThrow()
  return Number(res.insertId)
}

/** `password: undefined` keeps the stored one. */
export async function updateRegistry(
  id: number,
  values: { name: string; address: string; username: string; password?: string }
) {
  const db = await getDb()
  await db
    .updateTable("registries")
    .set({
      name: values.name,
      address: values.address,
      username: values.username,
      ...(values.password !== undefined ? { password: encryptSecret(values.password, CONTEXT) } : {}),
      updated_at: new Date().toISOString(),
    })
    .where("id", "=", id)
    .execute()
}

export async function deleteRegistry(id: number) {
  const db = await getDb()
  await db.deleteFrom("registries").where("id", "=", id).execute()
}

export async function getRegistryCredentials(id: number): Promise<RegistryCredentials | null> {
  const db = await getDb()
  const row = await db.selectFrom("registries").selectAll().where("id", "=", id).executeTakeFirst()
  return row ? { address: row.address, username: row.username, password: decryptSecret(row.password, CONTEXT) } : null
}

/**
 * Every stored login, decrypted (for docker compose's config.json). Logins
 * that can't be decrypted (the Gantry secret changed) are skipped and logged.
 */
export async function allRegistryCredentials(): Promise<RegistryCredentials[]> {
  const db = await getDb()
  const rows = await db.selectFrom("registries").selectAll().execute()
  const out: RegistryCredentials[] = []
  for (const r of rows) {
    try {
      out.push({ address: r.address, username: r.username, password: decryptSecret(r.password, CONTEXT) })
    } catch (err) {
      if (!(err instanceof SecretDecryptError)) throw err
      console.error(`[gantry] registry login for ${r.address} can't be decrypted; enter its password again`)
    }
  }
  return out
}

/** The stored login for the registry an image reference points at, if any. */
export async function credentialsForImage(reference: string): Promise<RegistryCredentials | null> {
  const address = registryOf(reference)
  const db = await getDb()
  const row = await db.selectFrom("registries").selectAll().where("address", "=", address).executeTakeFirst()
  if (!row) return null
  try {
    return { address: row.address, username: row.username, password: decryptSecret(row.password, CONTEXT) }
  } catch (err) {
    if (!(err instanceof SecretDecryptError)) throw err
    console.error(`[gantry] registry login for ${row.address} can't be decrypted; enter its password again`)
    return null
  }
}
