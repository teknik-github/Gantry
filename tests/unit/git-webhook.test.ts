import crypto from "node:crypto"

import { beforeEach, describe, expect, it, vi } from "vitest"

// The webhook delivery handler with its database and deploy dependencies
// mocked: status codes, ref filtering, size and rate limits, coalescing and
// the audit trail (which must never contain the secret).

const SECRET = "whsec_unit_test_secret_0123456789abcdef"
const HOOK = "h".repeat(32)
const audits: { action: string; target: string }[] = []

vi.mock("@/lib/server/audit", () => ({
  SYSTEM_ACTOR: (task: string) => ({ id: null, username: task }),
  audit: vi.fn(async (_actor: unknown, action: string, target: string) => {
    audits.push({ action, target })
  }),
}))
vi.mock("@/lib/server/db", () => ({ getDb: vi.fn() }))
vi.mock("@/lib/server/environment-target", () => ({ environmentTarget: vi.fn() }))
vi.mock("@/lib/server/stacks", () => ({
  getStack: vi.fn(async (id: number) => ({ id, name: "web", environment_id: 1, compose: "", env: "" })),
  isStackBusy: vi.fn(() => false),
  runStackOperation: vi.fn(),
  StackBusyError: class extends Error {},
}))
vi.mock("@/lib/server/stacks/git-records", () => ({
  findByWebhookId: vi.fn(async (id: string) =>
    id === HOOK || id === "r".repeat(32) || id === "s".repeat(32)
      ? { stack_id: id === HOOK ? 7 : id === "s".repeat(32) ? 9 : 8, ref: "main", webhook_id: id, webhook_secret: "enc" }
      : undefined
  ),
  webhookSecret: vi.fn(() => SECRET),
  getStackGit: vi.fn(),
  gitSource: vi.fn(),
  listPolledStacks: vi.fn(async () => []),
  markChecked: vi.fn(),
}))

vi.mock("@/lib/server/stacks/git", () => ({ remoteCommit: vi.fn() }))

const { handleWebhookDelivery, MAX_WEBHOOK_BODY, pollGitStacks } = await import("@/lib/server/stacks/git-sync")
const records = await import("@/lib/server/stacks/git-records")
const git = await import("@/lib/server/stacks/git")
const stacks = await import("@/lib/server/stacks")

function github(body: unknown, opts: { secret?: string; event?: string; hook?: string } = {}) {
  const text = JSON.stringify(body)
  const sig = crypto.createHmac("sha256", opts.secret ?? SECRET).update(text).digest("hex")
  return new Request(`http://gantry.test/api/webhooks/stacks/${opts.hook ?? HOOK}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GitHub-Event": opts.event ?? "push", "X-Hub-Signature-256": `sha256=${sig}` },
    body: text,
  })
}

beforeEach(() => {
  audits.length = 0
})

describe("handleWebhookDelivery", () => {
  it("accepts a signed push for the stack's branch and merges repeats", async () => {
    const res = await handleWebhookDelivery(HOOK, github({ ref: "refs/heads/main" }))
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ status: "accepted", redeploy: "scheduled" })
    const again = await handleWebhookDelivery(HOOK, github({ ref: "refs/heads/main" }))
    expect(again.body).toEqual({ status: "accepted", redeploy: "merged" })
    expect(audits.map((a) => a.action)).toEqual(["stack.webhook.accepted", "stack.webhook.accepted"])
    expect(audits[0].target).toContain("web refs/heads/main (github")
  })

  it("rejects a bad signature with 401", async () => {
    const res = await handleWebhookDelivery(HOOK, github({ ref: "refs/heads/main" }, { secret: "wrong" }))
    expect(res.status).toBe(401)
    expect(audits).toEqual([{ action: "stack.webhook.rejected", target: "web: invalid signature (github)" }])
  })

  it("rejects unsigned deliveries", async () => {
    const req = new Request(`http://gantry.test/api/webhooks/stacks/${HOOK}`, { method: "POST", body: "{}" })
    expect((await handleWebhookDelivery(HOOK, req)).status).toBe(401)
  })

  it("ignores other branches, deletions and other events", async () => {
    const other = await handleWebhookDelivery(HOOK, github({ ref: "refs/heads/dev" }))
    expect(other).toMatchObject({ status: 200, body: { status: "ignored" } })
    const deleted = await handleWebhookDelivery(HOOK, github({ ref: "refs/heads/main", deleted: true, after: "0".repeat(40) }))
    expect(deleted).toMatchObject({ status: 200, body: { status: "ignored" } })
    const issue = await handleWebhookDelivery(HOOK, github({ action: "opened" }, { event: "issues" }))
    expect(issue).toMatchObject({ status: 200, body: { status: "ignored" } })
    expect(audits.every((a) => a.action === "stack.webhook.ignored")).toBe(true)
  })

  it("answers GitHub's ping", async () => {
    const res = await handleWebhookDelivery(HOOK, github({ zen: "hi" }, { event: "ping" }))
    expect(res).toMatchObject({ status: 200, body: { message: "pong" } })
  })

  it("returns 404 for unknown hooks", async () => {
    const res = await handleWebhookDelivery("u".repeat(32), github({ ref: "refs/heads/main" }))
    expect(res.status).toBe(404)
    expect(audits).toEqual([{ action: "stack.webhook.rejected", target: "unknown webhook" }])
  })

  it("refuses oversized bodies, declared or streamed", async () => {
    const big = "x".repeat(MAX_WEBHOOK_BODY + 1)
    const declared = new Request(`http://gantry.test/api/webhooks/stacks/${HOOK}`, {
      method: "POST",
      headers: { "Content-Length": String(big.length) },
      body: big,
    })
    expect((await handleWebhookDelivery(HOOK, declared)).status).toBe(413)
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big))
        c.close()
      },
    })
    const chunked = new Request(`http://gantry.test/api/webhooks/stacks/${HOOK}`, { method: "POST", body: stream, duplex: "half" } as RequestInit)
    expect((await handleWebhookDelivery(HOOK, chunked)).status).toBe(413)
  })

  it("rate-limits deliveries per webhook", async () => {
    const hook = "r".repeat(32)
    const statuses: number[] = []
    for (let i = 0; i < 32; i++) {
      statuses.push((await handleWebhookDelivery(hook, github({ ref: "refs/heads/x" }, { hook }))).status)
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true)
    expect(statuses.slice(30)).toEqual([429, 429])
    // Other webhooks are unaffected.
    const other = "s".repeat(32)
    expect((await handleWebhookDelivery(other, github({ ref: "refs/heads/x" }, { hook: other }))).status).toBe(200)
  })

  it("never writes the secret to the audit log", async () => {
    const req = new Request(`http://gantry.test/api/webhooks/stacks/${HOOK}?token=${SECRET}`, { method: "POST" })
    await handleWebhookDelivery(HOOK, req)
    const gitlab = new Request(`http://gantry.test/api/webhooks/stacks/${HOOK}`, {
      method: "POST",
      headers: { "X-Gitlab-Token": `${SECRET}-nope`, "X-Gitlab-Event": "Push Hook" },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    })
    await handleWebhookDelivery(HOOK, gitlab)
    expect(audits.length).toBeGreaterThan(0)
    expect(JSON.stringify(audits)).not.toContain(SECRET)
  })
})

describe("pollGitStacks", () => {
  const row = (id: number, extra: Record<string, unknown> = {}) => ({
    stack_id: id,
    ref: "main",
    poll_minutes: 5,
    last_checked_at: null,
    commit_sha: "a".repeat(40),
    ...extra,
  })

  it("checks due stacks, skips busy or recently checked ones, and redeploys only new commits once", async () => {
    const now = Date.parse("2026-10-30T12:00:00Z")
    vi.mocked(records.listPolledStacks).mockResolvedValue([
      row(101), // due, remote moved -> redeploy
      row(102), // due, remote unchanged
      row(103, { last_checked_at: new Date(now - 60_000).toISOString() }), // checked a minute ago
      row(104), // busy
    ] as never)
    vi.mocked(stacks.isStackBusy).mockImplementation((id: number) => id === 104)
    vi.mocked(records.gitSource).mockImplementation((r: { stack_id: number }) => ({ url: "x", ref: String(r.stack_id), credentials: null }) as never)
    vi.mocked(git.remoteCommit).mockImplementation(async (src: { ref: string }) => (src.ref === "101" ? "b".repeat(40) : "a".repeat(40)))

    await pollGitStacks(now)
    expect(vi.mocked(records.markChecked).mock.calls.map((c) => c[0]).sort()).toEqual([101, 102])
    expect(vi.mocked(git.remoteCommit)).toHaveBeenCalledTimes(2)

    // While its redeploy is queued the stack is not checked or queued again.
    vi.mocked(records.markChecked).mockClear()
    await pollGitStacks(now + 10 * 60_000)
    expect(vi.mocked(records.markChecked).mock.calls.map((c) => c[0])).not.toContain(101)
  })
})
