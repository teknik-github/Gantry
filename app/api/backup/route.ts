import { z } from "zod"

import { audit } from "@/lib/server/audit"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { BackupFormatError, MIN_PASSPHRASE } from "@/lib/server/backup-format"
import { createBackup } from "@/lib/server/backup"

const bodySchema = z.object({ passphrase: z.string().min(MIN_PASSPHRASE).max(1024) })

/**
 * Creates a backup and returns it as a download: POST { "passphrase": "..." }.
 * Administrators only (session or API token, so scripts can take backups).
 */
export async function POST(request: Request) {
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 })
  if (user.role !== "admin") return Response.json({ error: "Only administrators can make backups" }, { status: 403 })

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return Response.json({ error: `Send a passphrase of at least ${MIN_PASSPHRASE} characters` }, { status: 400 })
  }
  try {
    const { name, data } = await createBackup(parsed.data.passphrase)
    await audit(user, "backup.download", name)
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (err) {
    if (err instanceof BackupFormatError) return Response.json({ error: err.message }, { status: 400 })
    console.error("[gantry] backup failed", err)
    return Response.json({ error: "The backup failed. Check the server logs." }, { status: 500 })
  }
}
