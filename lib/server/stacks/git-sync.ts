import "server-only"

import { refMatches, shortSha } from "@/lib/git-stacks"
import { audit, SYSTEM_ACTOR } from "@/lib/server/audit"
import { getDb } from "@/lib/server/db"
import { environmentTarget } from "@/lib/server/environment-target"
import { checkRateLimit, recordFailure } from "@/lib/server/rate-limit"
import { getStack, isStackBusy, runStackOperation, StackBusyError } from "@/lib/server/stacks"
import { remoteCommit } from "@/lib/server/stacks/git"
import { findByWebhookId, getStackGit, gitSource, listPolledStacks, markChecked, webhookSecret } from "@/lib/server/stacks/git-records"
import { RedeployQueue } from "@/lib/server/stacks/redeploy-queue"
import { parseDelivery, verifyDelivery, type WebhookProvider } from "@/lib/server/stacks/webhook"

// Background redeploys of Git stacks: webhook deliveries and polling. Both
// go through one queue per stack (see redeploy-queue.ts) and the per-stack
// lock, so concurrent triggers run one "Pull & redeploy" at a time.

export type Trigger = "webhook" | "poll"

/** Largest accepted webhook body (GitHub push payloads are usually a few KB). */
export const MAX_WEBHOOK_BODY = 1024 * 1024
/** Deliveries per webhook and minute. */
const WEBHOOK_RATE = 30
const UNKNOWN_RATE = 30
const RATE_WINDOW_MS = 60_000
/** How long a background run waits for a manual operation to finish. */
const BUSY_WAIT_MS = 30 * 60_000

const ACTOR_NAMES: Record<Trigger, string> = { webhook: "webhook", poll: "git poll" }

async function redeployInBackground(stackId: number, reasons: Trigger[]) {
  const trigger: Trigger = reasons.includes("webhook") ? "webhook" : "poll"
  const actor = SYSTEM_ACTOR(ACTOR_NAMES[trigger])
  const deadline = Date.now() + BUSY_WAIT_MS
  for (;;) {
    const stack = await getStack(stackId)
    if (!stack || !(await getStackGit(stackId))) return
    const db = await getDb()
    const env = await db.selectFrom("environments").selectAll().where("id", "=", stack.environment_id).executeTakeFirst()
    if (!env) return
    try {
      const run = await runStackOperation(stack, environmentTarget(env), "redeploy", actor.username)
      const sha = run.commit ? ` at ${shortSha(run.commit.sha)}` : ""
      if (run.skipped) await audit(actor, "stack.redeploy.skipped", `${stack.name}${sha} (unchanged)`)
      else await audit(actor, run.code === 0 ? "stack.redeploy" : "stack.redeploy.failed", `${stack.name}${sha}`)
      return
    } catch (err) {
      // A manual operation holds the lock: wait for it, then deploy what's newest.
      if (err instanceof StackBusyError && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5_000))
        continue
      }
      await audit(actor, "stack.redeploy.failed", `${stack.name}: ${(err as Error).message}`.slice(0, 255))
      console.error(`[gantry] background redeploy of ${stack.name} failed`, err)
      return
    }
  }
}

const globalForGit = globalThis as unknown as {
  __gantryGitQueue?: RedeployQueue<number, Trigger>
  __gantryGitPoller?: PollerState
}
type PollerState = { timer?: ReturnType<typeof setInterval>; running: boolean; attempted: Map<number, string> }
const queue = (globalForGit.__gantryGitQueue ??= new RedeployQueue<number, Trigger>(redeployInBackground))

/** Asks for a background "Pull & redeploy" of a Git stack (coalesced). */
export function requestGitRedeploy(stackId: number, trigger: Trigger) {
  return queue.request(stackId, trigger)
}

export type WebhookResponse = { status: number; body: Record<string, unknown>; headers?: Record<string, string> }

/**
 * Handles one webhook delivery: rate limit, size limit, signature, event and
 * ref checks, then queues the redeploy and answers 202 right away. Every
 * delivery that gets past the rate limit is audited (never the secret).
 */
export async function handleWebhookDelivery(hookId: string, request: Request): Promise<WebhookResponse> {
  const actor = SYSTEM_ACTOR("webhook")
  const rateKey = `webhook:${hookId}`
  const wait = checkRateLimit(rateKey, WEBHOOK_RATE)
  if (wait) return { status: 429, body: { error: "Too many deliveries" }, headers: { "Retry-After": String(wait) } }

  const git = await findByWebhookId(hookId)
  if (!git) {
    // Unknown ids share one budget so probing can't flood the audit log.
    const unknownWait = checkRateLimit("webhook:unknown", UNKNOWN_RATE)
    if (unknownWait) return { status: 429, body: { error: "Too many deliveries" }, headers: { "Retry-After": String(unknownWait) } }
    recordFailure("webhook:unknown", RATE_WINDOW_MS)
    await audit(actor, "stack.webhook.rejected", "unknown webhook")
    return { status: 404, body: { error: "Unknown webhook" } }
  }
  recordFailure(rateKey, RATE_WINDOW_MS)

  const stack = await getStack(git.stack_id)
  const name = stack?.name ?? `#${git.stack_id}`
  const reject = async (status: number, reason: string, provider: WebhookProvider | null = null) => {
    await audit(actor, "stack.webhook.rejected", `${name}: ${reason}${provider ? ` (${provider})` : ""}`)
    return { status, body: { error: reason } }
  }

  const body = await readLimited(request, MAX_WEBHOOK_BODY)
  if (!body) return reject(413, "payload too large")

  const secret = webhookSecret(git)
  if (!secret) return reject(503, "webhook secret unreadable; regenerate it")
  const verified = verifyDelivery(request.headers, new URL(request.url), body, secret)
  if (!verified.ok) return reject(401, verified.reason, verified.provider)
  const provider = verified.provider

  let delivery
  try {
    delivery = parseDelivery(provider, request.headers, body)
  } catch {
    return reject(400, "unreadable payload", provider)
  }

  const ignore = async (reason: string) => {
    await audit(actor, "stack.webhook.ignored", `${name}: ${reason} (${provider})`)
    return { status: 200, body: { status: "ignored", reason } }
  }
  if (delivery.kind === "ping") {
    await audit(actor, "stack.webhook.ping", `${name} (${provider})`)
    return { status: 200, body: { status: "ok", message: "pong" } }
  }
  if (delivery.kind === "other") return ignore(`event ${delivery.event.slice(0, 40)}`)
  if (delivery.ref !== null && !refMatches(git.ref, delivery.ref)) {
    return ignore(`ref ${delivery.ref.slice(0, 100)} is not ${git.ref}`)
  }
  if (delivery.deleted) return ignore(`ref ${delivery.ref ?? ""} was deleted`)
  if (!stack) return reject(404, "stack not found", provider)

  const outcome = requestGitRedeploy(stack.id, "webhook")
  await audit(actor, "stack.webhook.accepted", `${name}${delivery.ref ? ` ${delivery.ref.slice(0, 100)}` : ""} (${provider}, ${outcome})`)
  return { status: 202, body: { status: "accepted", redeploy: outcome } }
}

/** Reads at most `max` bytes of the body; null when it is larger. */
async function readLimited(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > max) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

const poller: PollerState = (globalForGit.__gantryGitPoller ??= { running: false, attempted: new Map() })

/**
 * One polling pass: for each Git stack with polling on whose interval has
 * passed, asks the remote for the ref's commit and queues a redeploy when
 * it isn't the deployed one (and wasn't already tried). Busy stacks wait
 * for the next pass.
 */
export async function pollGitStacks(now = Date.now()) {
  if (poller.running) return
  poller.running = true
  try {
    for (const git of await listPolledStacks()) {
      const last = git.last_checked_at ? Date.parse(git.last_checked_at) : 0
      if (now - last < git.poll_minutes * 60_000) continue
      if (isStackBusy(git.stack_id) || queue.pending(git.stack_id)) continue
      await markChecked(git.stack_id, new Date(now).toISOString())
      try {
        const sha = await remoteCommit(gitSource(git))
        if (!sha || sha === git.commit_sha || poller.attempted.get(git.stack_id) === sha) continue
        poller.attempted.set(git.stack_id, sha)
        requestGitRedeploy(git.stack_id, "poll")
      } catch (err) {
        console.warn(`[gantry] polling stack #${git.stack_id} failed: ${(err as Error).message}`)
      }
    }
  } finally {
    poller.running = false
  }
}

/** Checks every minute which Git stacks are due for a poll. */
export async function startGitPoller() {
  if (poller.timer) return
  poller.timer = setInterval(() => {
    pollGitStacks().catch((err) => console.error("[gantry] git polling failed", err))
  }, 60_000)
  poller.timer.unref?.()
}
