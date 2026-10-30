import { audit } from "@/lib/server/audit"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { MAX_BACKUP_BYTES, restoreBackup, RestoreError } from "@/lib/server/backup"

/**
 * Restores a backup: multipart form with `file`, `passphrase` and
 * `confirm=RESTORE`. Replaces all of Gantry's data. Administrators with a
 * browser session only (never an API token).
 */
export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 })
  if (user.role !== "admin" || user.via !== "session") {
    return Response.json({ error: "Only administrators can restore, from the web interface" }, { status: 403 })
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BACKUP_BYTES + 1024 * 1024) {
    return Response.json({ error: "The file is too large" }, { status: 413 })
  }

  const form = await request.formData().catch(() => null)
  const file = form?.get("file")
  const passphrase = form?.get("passphrase")
  if (!(file instanceof File) || typeof passphrase !== "string" || !passphrase) {
    return Response.json({ error: "Choose a backup file and enter its passphrase" }, { status: 400 })
  }
  if (form?.get("confirm") !== "RESTORE") {
    return Response.json({ error: 'Type RESTORE to confirm that all current data will be replaced' }, { status: 400 })
  }
  if (file.size > MAX_BACKUP_BYTES) return Response.json({ error: "The file is too large" }, { status: 413 })

  try {
    const result = await restoreBackup(Buffer.from(await file.arrayBuffer()), passphrase)
    // Logged into the restored audit log.
    await audit({ id: null, username: user.username }, "backup.restore", `${file.name} (${result.createdAt})`)
    return Response.json(result)
  } catch (err) {
    if (err instanceof RestoreError) return Response.json({ error: err.message }, { status: 400 })
    console.error("[gantry] restore failed", err)
    return Response.json({ error: "The restore failed and nothing was changed. Check the server logs." }, { status: 500 })
  }
}
