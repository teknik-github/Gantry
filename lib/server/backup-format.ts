import "server-only"

import crypto from "node:crypto"
import zlib from "node:zlib"

/**
 * Gantry backup files: a JSON snapshot, gzipped, then encrypted with
 * AES-256-GCM under a key derived from a passphrase (scrypt). Layout:
 *
 *   "GANTRY-BACKUP\n" | version (1 byte) | salt (16) | iv (12) | tag (16) | ciphertext
 *
 * The header is bound as additional authenticated data, so a tampered or
 * truncated file fails to decrypt instead of restoring garbage.
 */

const MAGIC = Buffer.from("GANTRY-BACKUP\n", "ascii")
const VERSION = 1
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES
// N=2^15 takes ~100 ms and 32 MB: fine for a manual or nightly operation.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export const MIN_PASSPHRASE = 12

export class BackupFormatError extends Error {}

export type BackupPayload = {
  format: "gantry-backup"
  version: 1
  createdAt: string
  /** Applied migrations of the Gantry that made it. */
  migrations: string[]
  /** The secret that encrypted values in the tables were sealed with. */
  secret: { source: "file" | "env"; value: string }
  tables: Record<string, Record<string, unknown>[]>
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(passphrase.normalize("NFKC"), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)))
  )
}

export async function encodeBackup(payload: BackupPayload, passphrase: string): Promise<Buffer> {
  if (passphrase.length < MIN_PASSPHRASE) throw new BackupFormatError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters`)
  const salt = crypto.randomBytes(SALT_BYTES)
  const iv = crypto.randomBytes(IV_BYTES)
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv])
  const key = await deriveKey(passphrase, salt)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(header)
  const body = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(JSON.stringify(payload), "utf8"))), cipher.final()])
  return Buffer.concat([header, cipher.getAuthTag(), body])
}

export function isBackupFile(data: Buffer) {
  return data.length > HEADER_BYTES + TAG_BYTES && data.subarray(0, MAGIC.length).equals(MAGIC)
}

export async function decodeBackup(data: Buffer, passphrase: string): Promise<BackupPayload> {
  if (!isBackupFile(data)) throw new BackupFormatError("This isn't a Gantry backup file")
  const version = data[MAGIC.length]
  if (version !== VERSION) throw new BackupFormatError(`Unsupported backup version ${version}; use a newer Gantry`)
  const header = data.subarray(0, HEADER_BYTES)
  const salt = data.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES)
  const iv = data.subarray(MAGIC.length + 1 + SALT_BYTES, HEADER_BYTES)
  const tag = data.subarray(HEADER_BYTES, HEADER_BYTES + TAG_BYTES)
  const key = await deriveKey(passphrase, salt)
  let json: string
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAAD(header)
    decipher.setAuthTag(tag)
    const zipped = Buffer.concat([decipher.update(data.subarray(HEADER_BYTES + TAG_BYTES)), decipher.final()])
    json = zlib.gunzipSync(zipped, { maxOutputLength: 2 * 1024 * 1024 * 1024 }).toString("utf8")
  } catch {
    throw new BackupFormatError("Wrong passphrase, or the file is damaged")
  }
  const payload = JSON.parse(json) as BackupPayload
  if (payload?.format !== "gantry-backup" || payload.version !== 1 || typeof payload.tables !== "object" || !payload.secret?.value) {
    throw new BackupFormatError("The backup's content isn't recognised")
  }
  return payload
}

/** File name for a backup made at `date`. */
export function backupFileName(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-")
  return `gantry-backup-${stamp}.gbk`
}

export const BACKUP_FILE_RE = /^gantry-backup-\d{8}-\d{6}Z\.gbk$/
