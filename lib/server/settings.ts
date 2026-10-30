import "server-only"

import { getDb } from "@/lib/server/db"

// Small key/value settings stored in the database (changed from the UI).

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb()
  const row = await db.selectFrom("settings").select("value").where("key", "=", key).executeTakeFirst()
  return row?.value ?? null
}

export async function setSetting(key: string, value: string) {
  const db = await getDb()
  const updated = await db.updateTable("settings").set({ value }).where("key", "=", key).executeTakeFirst()
  if (Number(updated.numUpdatedRows) === 0) await db.insertInto("settings").values({ key, value }).execute()
}
