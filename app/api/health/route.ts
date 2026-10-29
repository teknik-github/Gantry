import { connection } from "next/server"

import { getDb } from "@/lib/server/db"

// Public (see proxy.ts): used by the Docker healthcheck. Reveals nothing but up/down.
export async function GET() {
  await connection()
  try {
    await getDb()
    return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json({ status: "error" }, { status: 503 })
  }
}
