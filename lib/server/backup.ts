import "server-only"

import fs from "node:fs/promises"
import path from "node:path"

import { sql, type Kysely } from "kysely"

import { config, getSessionSecret } from "@/lib/server/config"
import { decryptSecret, encryptSecret, SecretDecryptError } from "@/lib/server/crypto"
import { getDb } from "@/lib/server/db"
import {
  BACKUP_FILE_RE,
  backupFileName,
  BackupFormatError,
  decodeBackup,
  encodeBackup,
  MIN_PASSPHRASE,
  type BackupPayload,
} from "@/lib/server/backup-format"
import { scheduledRunDue } from "@/lib/server/auto-update"
import { notify } from "@/lib/server/notifications"
import { getSetting, setSetting } from "@/lib/server/settings"

/**
 * Backups of everything Gantry stores: every table (read through schema
 * introspection, so new tables are included automatically) plus the secret
 * that seals the encrypted columns (TLS keys, cluster and Git credentials,
 * registry passwords, 2FA secrets, notification settings). The format is
 * driver-independent: a SQLite backup restores into MySQL and back.
 *
 * Stack directories aren't included: they are rewritten from the database
 * on the next deploy, and Git checkouts are fetched again.
 */

/** Tables that belong to the migrator, not to Gantry's data. */
const SKIP_TABLES = new Set(["kysely_migration", "kysely_migration_lock"])
const INSERT_BATCH = 200
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024

// Kysely without a schema type: tables are discovered at runtime.
type AnyDb = Kysely<Record<string, Record<string, unknown>>>

export function backupDir() {
  return path.resolve(process.env.BACKUP_DIR || path.join(config.dataDir, "backups"))
}

function secretInfo(): BackupPayload["secret"] {
  return {
    source: process.env.GANTRY_SECRET ? "env" : "file",
    value: new TextDecoder().decode(getSessionSecret()),
  }
}

async function dataTables(db: AnyDb) {
  const tables = await db.introspection.getTables()
  return tables.filter((t) => !SKIP_TABLES.has(t.name) && !t.isView)
}

async function appliedMigrations(db: AnyDb): Promise<string[]> {
  const rows = await db.selectFrom("kysely_migration").select("name").orderBy("name").execute()
  return rows.map((r) => String(r.name))
}

/** A snapshot of every table, plus the secret. */
export async function snapshot(): Promise<BackupPayload> {
  const db = (await getDb()) as unknown as AnyDb
  const tables: BackupPayload["tables"] = {}
  for (const t of await dataTables(db)) {
    tables[t.name] = await db.selectFrom(t.name).selectAll().execute()
  }
  return {
    format: "gantry-backup",
    version: 1,
    createdAt: new Date().toISOString(),
    migrations: await appliedMigrations(db),
    secret: secretInfo(),
    tables,
  }
}

export async function createBackup(passphrase: string): Promise<{ name: string; data: Buffer }> {
  const payload = await snapshot()
  return { name: backupFileName(new Date(payload.createdAt)), data: await encodeBackup(payload, passphrase) }
}

export class RestoreError extends Error {}

export type RestoreResult = {
  rows: number
  tables: number
  /** The backup's secret differs from the running one: Gantry must be restarted. */
  restartRequired: boolean
  createdAt: string
}

/**
 * Replaces all of Gantry's data with the backup's, in one transaction
 * (foreign keys checked at commit). Columns the backup doesn't have keep
 * their defaults; tables it doesn't have end up empty. Every session is
 * invalidated. A different secret is written to DATA_DIR/secret.key only
 * after the data is committed (Gantry must then be restarted).
 */
export async function restoreBackup(data: Buffer, passphrase: string): Promise<RestoreResult> {
  let payload: BackupPayload
  try {
    payload = await decodeBackup(data, passphrase)
  } catch (err) {
    if (err instanceof BackupFormatError) throw new RestoreError(err.message)
    throw err
  }
  const db = (await getDb()) as unknown as AnyDb

  const known = new Set(await appliedMigrations(db))
  const newer = payload.migrations.filter((m) => !known.has(m))
  if (newer.length) {
    throw new RestoreError(`This backup comes from a newer Gantry (migrations ${newer.join(", ")}); upgrade first.`)
  }

  const current = secretInfo()
  const secretChanges = payload.secret.value !== current.value
  if (secretChanges && current.source === "env") {
    throw new RestoreError(
      "This backup was made with a different secret, and GANTRY_SECRET is set. Set GANTRY_SECRET to the value the backup's Gantry used, restart, and restore again."
    )
  }
  // Written now, moved into place after the commit (a failed restore leaves the old secret).
  const secretFile = path.join(config.dataDir, "secret.key")
  const pendingSecret = `${secretFile}.restore`
  if (secretChanges) await fs.writeFile(pendingSecret, payload.secret.value, { mode: 0o600 })

  const tables = await dataTables(db)
  let rows = 0
  try {
    await db.transaction().execute(async (trx) => {
      if (config.dbDriver === "mysql") await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(trx)
      else await sql`PRAGMA defer_foreign_keys = ON`.execute(trx)

      for (const t of tables) await trx.deleteFrom(t.name).execute()
      for (const t of tables) {
        const columns = new Set(t.columns.map((c) => c.name))
        const source = payload.tables[t.name] ?? []
        const clean = source.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => columns.has(k))))
        for (let i = 0; i < clean.length; i += INSERT_BATCH) {
          await trx.insertInto(t.name).values(clean.slice(i, i + INSERT_BATCH)).execute()
        }
        rows += clean.length
      }
      // Nobody stays signed in with a session from before the restore.
      if (tables.some((t) => t.name === "users")) {
        await sql`UPDATE users SET session_version = session_version + 1`.execute(trx)
      }
      if (config.dbDriver === "mysql") await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(trx)
    })
  } catch (err) {
    if (secretChanges) await fs.rm(pendingSecret, { force: true })
    throw err
  }
  if (secretChanges) await fs.rename(pendingSecret, secretFile)
  return { rows, tables: tables.length, restartRequired: secretChanges, createdAt: payload.createdAt }
}

// ---------------------------------------------------------------- Stored and scheduled backups

export type StoredBackup = { name: string; size: number; createdAt: string }

export async function listStoredBackups(): Promise<StoredBackup[]> {
  const dir = backupDir()
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const out: StoredBackup[] = []
  for (const name of names.filter((n) => BACKUP_FILE_RE.test(n))) {
    const st = await fs.stat(path.join(dir, name)).catch(() => null)
    if (st?.isFile()) out.push({ name, size: st.size, createdAt: st.mtime.toISOString() })
  }
  return out.sort((a, b) => b.name.localeCompare(a.name))
}

/** Path of a stored backup by name; null for anything that isn't one (no path tricks). */
export function storedBackupPath(name: string) {
  return BACKUP_FILE_RE.test(name) ? path.join(backupDir(), name) : null
}

export async function deleteStoredBackup(name: string) {
  const file = storedBackupPath(name)
  if (!file) throw new RestoreError("Not a backup file")
  await fs.rm(file, { force: true })
}

const KEYS = {
  enabled: "backup.enabled",
  time: "backup.time",
  keep: "backup.keep",
  passphrase: "backup.passphrase",
  last: "backup.last",
}
const PASSPHRASE_CONTEXT = "backup-passphrase"

export type BackupSchedule = { enabled: boolean; time: string; keep: number; hasPassphrase: boolean }
export type LastBackup = { at: string; name?: string; error?: string; trigger: "schedule" | "manual" }

export async function getBackupSchedule(): Promise<BackupSchedule> {
  const [enabled, time, keep, passphrase] = await Promise.all([
    getSetting(KEYS.enabled),
    getSetting(KEYS.time),
    getSetting(KEYS.keep),
    getSetting(KEYS.passphrase),
  ])
  const k = Number(keep)
  return {
    enabled: enabled === "1",
    time: time && /^\d{2}:\d{2}$/.test(time) ? time : "02:30",
    keep: Number.isInteger(k) && k >= 1 && k <= 365 ? k : 7,
    hasPassphrase: Boolean(passphrase),
  }
}

/** `passphrase` undefined keeps the stored one. */
export async function saveBackupSchedule(s: { enabled: boolean; time: string; keep: number; passphrase?: string }) {
  if (s.passphrase !== undefined) {
    if (s.passphrase.length < MIN_PASSPHRASE) throw new RestoreError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters`)
    await setSetting(KEYS.passphrase, encryptSecret(s.passphrase, PASSPHRASE_CONTEXT))
  }
  if (s.enabled && s.passphrase === undefined && !(await getSetting(KEYS.passphrase))) {
    throw new RestoreError("Set a passphrase for scheduled backups")
  }
  await setSetting(KEYS.enabled, s.enabled ? "1" : "0")
  await setSetting(KEYS.time, s.time)
  await setSetting(KEYS.keep, String(s.keep))
}

export async function lastBackup(): Promise<LastBackup | null> {
  const raw = await getSetting(KEYS.last)
  try {
    return raw ? (JSON.parse(raw) as LastBackup) : null
  } catch {
    return null
  }
}

async function storedPassphrase() {
  const value = await getSetting(KEYS.passphrase)
  if (!value) throw new RestoreError("No passphrase is set for scheduled backups")
  try {
    return decryptSecret(value, PASSPHRASE_CONTEXT)
  } catch (err) {
    if (err instanceof SecretDecryptError) throw new RestoreError("The stored backup passphrase can't be decrypted; set it again")
    throw err
  }
}

/** Writes a backup to the backup directory with the stored passphrase and prunes old ones. */
export async function runStoredBackup(trigger: LastBackup["trigger"]): Promise<StoredBackup> {
  const at = new Date().toISOString()
  try {
    const { name, data } = await createBackup(await storedPassphrase())
    const dir = backupDir()
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const tmp = path.join(dir, `.${name}.tmp`)
    await fs.writeFile(tmp, data, { mode: 0o600 })
    await fs.rename(tmp, path.join(dir, name))
    const { keep } = await getBackupSchedule()
    for (const old of (await listStoredBackups()).slice(keep)) await deleteStoredBackup(old.name)
    await setSetting(KEYS.last, JSON.stringify({ at, name, trigger } satisfies LastBackup))
    return { name, size: data.length, createdAt: at }
  } catch (err) {
    const error = (err as Error).message
    await setSetting(KEYS.last, JSON.stringify({ at, error, trigger } satisfies LastBackup))
    await notify({ kind: "backup", environment: "Gantry", subject: "Backup failed", message: error })
    throw err
  }
}

const globalForBackup = globalThis as unknown as {
  __gantryBackup?: { timer?: ReturnType<typeof setInterval>; lastScheduledDay?: string; running: boolean }
}
const state = (globalForBackup.__gantryBackup ??= { running: false })

/** Checks every 30 s whether today's scheduled backup is due (server time zone). */
export async function startBackupScheduler() {
  if (state.timer) return
  state.timer = setInterval(async () => {
    try {
      const schedule = await getBackupSchedule()
      const now = new Date()
      if (!schedule.enabled || state.running || !scheduledRunDue(now, schedule.time, state.lastScheduledDay)) return
      state.lastScheduledDay = now.toLocaleDateString("en-CA")
      state.running = true
      try {
        const b = await runStoredBackup("schedule")
        console.log(`[gantry] backup written: ${b.name}`)
      } finally {
        state.running = false
      }
    } catch (err) {
      console.error("[gantry] scheduled backup failed", (err as Error).message)
    }
  }, 30_000)
  state.timer.unref?.()
}
