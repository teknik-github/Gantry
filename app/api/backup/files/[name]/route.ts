import fs from "node:fs/promises"

import { audit } from "@/lib/server/audit"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { storedBackupPath } from "@/lib/server/backup"

/** Downloads a stored (scheduled) backup. Administrators only. */
export async function GET(_request: Request, ctx: RouteContext<"/api/backup/files/[name]">) {
  const user = await getCurrentUser()
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 })
  if (user.role !== "admin") return Response.json({ error: "Only administrators can download backups" }, { status: 403 })

  const { name } = await ctx.params
  const file = storedBackupPath(name)
  const data = file ? await fs.readFile(/* turbopackIgnore: true */ file).catch(() => null) : null
  if (!data) return Response.json({ error: "Backup not found" }, { status: 404 })
  await audit(user, "backup.download", name)
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  })
}
