import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

// Backups against a real (temporary) SQLite database: the data directory is
// set before Gantry's modules load, so they use it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-backup-test-"))
process.env.DATA_DIR = dir
process.env.BACKUP_DIR = path.join(dir, "backups")

type Mods = {
  format: typeof import("@/lib/server/backup-format")
  backup: typeof import("@/lib/server/backup")
  db: typeof import("@/lib/server/db")
}
let m: Mods

beforeAll(async () => {
  m = {
    format: await import("@/lib/server/backup-format"),
    backup: await import("@/lib/server/backup"),
    db: await import("@/lib/server/db"),
  }
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const PASS = "correct horse battery staple"

describe("backup file format", () => {
  const payload = () => ({
    format: "gantry-backup" as const,
    version: 1 as const,
    createdAt: "2026-10-30T00:00:00.000Z",
    migrations: ["001_initial"],
    secret: { source: "file" as const, value: "s".repeat(64) },
    tables: { things: [{ id: 1, name: "a" }] },
  })

  it("round-trips with the passphrase", async () => {
    const data = await m.format.encodeBackup(payload(), PASS)
    expect(m.format.isBackupFile(data)).toBe(true)
    expect(data.includes(Buffer.from("s".repeat(64)))).toBe(false)
    expect(await m.format.decodeBackup(data, PASS)).toEqual(payload())
  })

  it("refuses a wrong passphrase, a tampered file, other files and short passphrases", async () => {
    const data = await m.format.encodeBackup(payload(), PASS)
    await expect(m.format.decodeBackup(data, "wrong passphrase!!")).rejects.toThrow(/Wrong passphrase/)
    const tampered = Buffer.from(data)
    tampered[tampered.length - 5] ^= 0xff
    await expect(m.format.decodeBackup(tampered, PASS)).rejects.toThrow(/Wrong passphrase, or the file is damaged/)
    const header = Buffer.from(data)
    header[20] ^= 0xff // inside the salt: authenticated as part of the header
    await expect(m.format.decodeBackup(header, PASS)).rejects.toThrow()
    await expect(m.format.decodeBackup(Buffer.from("PK\u0003\u0004 zip"), PASS)).rejects.toThrow(/isn't a Gantry backup/)
    await expect(m.format.encodeBackup(payload(), "short")).rejects.toThrow(/at least 12/)
  })

  it("names files predictably", () => {
    const name = m.format.backupFileName(new Date("2026-10-30T17:05:09.123Z"))
    expect(name).toBe("gantry-backup-20261030-170509Z.gbk")
    expect(m.format.BACKUP_FILE_RE.test(name)).toBe(true)
    expect(m.backup.storedBackupPath("../secret.key")).toBeNull()
  })
})

describe("snapshot and restore", () => {
  it("restores every table and signs everyone out", async () => {
    const db = await m.db.getDb()
    const now = new Date().toISOString()
    await db.insertInto("users").values({ username: "alice", password_hash: "x", role: "admin", created_at: now }).execute()
    await db.insertInto("templates").values({
      title: "Kept",
      description: "",
      category: "Custom",
      stack_name: "kept",
      compose: "services:\n  a:\n    image: alpine\n",
      env: "",
      created_by: "alice",
      created_at: now,
      updated_at: now,
    }).execute()
    const usersBefore = await db.selectFrom("users").selectAll().orderBy("id").execute()

    const { data } = await m.backup.createBackup(PASS)

    // Changes after the backup...
    await db.deleteFrom("templates").execute()
    await db.insertInto("users").values({ username: "mallory", password_hash: "y", role: "admin", created_at: now }).execute()

    const result = await m.backup.restoreBackup(data, PASS)
    expect(result.restartRequired).toBe(false)

    // ...are undone.
    const usersAfter = await db.selectFrom("users").selectAll().orderBy("id").execute()
    expect(usersAfter.map((u) => u.username)).toEqual(usersBefore.map((u) => u.username))
    expect(usersAfter.map((u) => Number(u.session_version))).toEqual(usersBefore.map((u) => Number(u.session_version) + 1))
    expect((await db.selectFrom("templates").select("title").execute()).map((t) => t.title)).toEqual(["Kept"])

    // A new row still gets a fresh id after explicit ids were restored.
    await db.insertInto("users").values({ username: "bob", password_hash: "z", role: "user", created_at: now }).execute()
    const bob = await db.selectFrom("users").select("id").where("username", "=", "bob").executeTakeFirstOrThrow()
    expect(Number(bob.id)).toBeGreaterThan(Math.max(...usersBefore.map((u) => Number(u.id))))
  })

  it("refuses backups from a newer Gantry and, with GANTRY_SECRET set, from another secret", async () => {
    const snap = await m.backup.snapshot()
    const newer = await m.format.encodeBackup({ ...snap, migrations: [...snap.migrations, "999_future"] }, PASS)
    await expect(m.backup.restoreBackup(newer, PASS)).rejects.toThrow(/newer Gantry/)

    const otherSecret = await m.format.encodeBackup({ ...snap, secret: { source: "file", value: "o".repeat(64) } }, PASS)
    await expect(m.backup.restoreBackup(otherSecret, PASS)).rejects.toThrow(/different secret, and GANTRY_SECRET is set/)
  })

  it("keeps only the newest stored backups", async () => {
    await m.backup.saveBackupSchedule({ enabled: false, time: "02:30", keep: 2, passphrase: PASS })
    const names: string[] = []
    for (let i = 0; i < 3; i++) {
      names.push((await m.backup.runStoredBackup("manual")).name)
      await new Promise((r) => setTimeout(r, 1100)) // names have second precision
    }
    const stored = await m.backup.listStoredBackups()
    expect(stored.map((b) => b.name)).toEqual([names[2], names[1]])
    expect(fs.statSync(path.join(process.env.BACKUP_DIR!, names[2])).mode & 0o777).toBe(0o600)
    // A stored backup restores with the scheduled passphrase.
    const data = fs.readFileSync(path.join(process.env.BACKUP_DIR!, names[2]))
    await expect(m.backup.restoreBackup(data, PASS)).resolves.toMatchObject({ restartRequired: false })
  })
})
