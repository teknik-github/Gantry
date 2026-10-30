import type { NextRequest } from "next/server"

import { WEBHOOK_ID_RE } from "@/lib/git-stacks"
import { handleWebhookDelivery } from "@/lib/server/stacks/git-sync"

// Git push webhooks for Git stacks. Public (see proxy.ts, POST only): each
// delivery is authenticated by the stack's webhook secret instead of a
// session. Answers right away; the redeploy runs in the background.
export async function POST(request: NextRequest, ctx: RouteContext<"/api/webhooks/stacks/[hookId]">) {
  const { hookId } = await ctx.params
  const headers = { "Cache-Control": "no-store" }
  if (!WEBHOOK_ID_RE.test(hookId)) return Response.json({ error: "Unknown webhook" }, { status: 404, headers })
  const res = await handleWebhookDelivery(hookId, request)
  return Response.json(res.body, { status: res.status, headers: { ...headers, ...res.headers } })
}
