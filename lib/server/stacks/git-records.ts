import "server-only"

import crypto from "node:crypto"

import { decryptSecret, encryptSecret, SecretDecryptError } from "@/lib/server/crypto"
import { getDb } from "@/lib/server/db"
import type { StackGit } from "@/lib/server/db/schema"
import type { CommitInfo, GitCredentials, GitSource } from "@/lib/server/stacks/git"

// Git source records of stacks (table stack_git). Credentials and the webhook
// secret are encrypted with the stack id bound as context, so a value copied
// to another stack or column doesn't decrypt. Neither ever leaves the server.

const credentialsContext = (stackId: number) => `stack_git.credentials:${stackId}`
const webhookContext = (stackId: number) => `stack_git.webhook_secret:${stackId}`

/** What pages may show about a Git stack (no credentials, no secret). */
export type GitStackInfo = {
  url: string
  ref: string
  composePath: string
  hasCredentials: boolean
  commit: CommitInfo | null
  webhookId: string | null
  pollMinutes: number
  lastCheckedAt: string | null
}

export async function getStackGit(stackId: number): Promise<StackGit | undefined> {
  const db = await getDb()
  return db.selectFrom("stack_git").selectAll().where("stack_id", "=", stackId).executeTakeFirst()
}

export function publicGitInfo(row: StackGit): GitStackInfo {
  return {
    url: row.repo_url,
    ref: row.ref,
    composePath: row.compose_path,
    hasCredentials: Boolean(row.credentials),
    commit: row.commit_sha
      ? { sha: row.commit_sha, subject: row.commit_subject ?? "", author: row.commit_author ?? "", date: row.commit_date ?? "" }
      : null,
    webhookId: row.webhook_id,
    pollMinutes: row.poll_minutes,
    lastCheckedAt: row.last_checked_at,
  }
}

/** Ids of the Git stacks among `stackIds` (for list badges). */
export async function gitStackIds(stackIds: number[]): Promise<Set<number>> {
  if (!stackIds.length) return new Set()
  const db = await getDb()
  const rows = await db.selectFrom("stack_git").select("stack_id").where("stack_id", "in", stackIds).execute()
  return new Set(rows.map((r) => r.stack_id))
}

export class GitCredentialsError extends Error {
  constructor() {
    super("The stored Git credentials can't be decrypted (was GANTRY_SECRET changed?). Enter them again.")
  }
}

export function gitSource(row: StackGit): GitSource {
  let credentials: GitCredentials | null = null
  if (row.credentials) {
    try {
      credentials = JSON.parse(decryptSecret(row.credentials, credentialsContext(row.stack_id))) as GitCredentials
    } catch (err) {
      if (err instanceof SecretDecryptError || err instanceof SyntaxError) throw new GitCredentialsError()
      throw err
    }
  }
  return { url: row.repo_url, ref: row.ref, credentials }
}

export function encryptCredentials(stackId: number, creds: GitCredentials | null) {
  return creds ? encryptSecret(JSON.stringify(creds), credentialsContext(stackId)) : null
}

export async function insertStackGit(values: {
  stackId: number
  url: string
  ref: string
  composePath: string
  credentials: GitCredentials | null
  pollMinutes: number
}) {
  const db = await getDb()
  const now = new Date().toISOString()
  await db
    .insertInto("stack_git")
    .values({
      stack_id: values.stackId,
      repo_url: values.url,
      ref: values.ref,
      compose_path: values.composePath,
      credentials: encryptCredentials(values.stackId, values.credentials),
      poll_minutes: values.pollMinutes,
      created_at: now,
      updated_at: now,
    })
    .execute()
}

/** `credentials`: "keep" leaves the stored ones, null removes them. */
export async function updateStackGitSource(
  stackId: number,
  values: { url: string; ref: string; composePath: string; credentials: GitCredentials | null | "keep"; pollMinutes: number }
) {
  const db = await getDb()
  await db
    .updateTable("stack_git")
    .set({
      repo_url: values.url,
      ref: values.ref,
      compose_path: values.composePath,
      poll_minutes: values.pollMinutes,
      ...(values.credentials === "keep" ? {} : { credentials: encryptCredentials(stackId, values.credentials) }),
      updated_at: new Date().toISOString(),
    })
    .where("stack_id", "=", stackId)
    .execute()
}

/** Fingerprint of what a deploy used; an unchanged one means nothing to redeploy. */
export function deployFingerprint(commitSha: string, env: string, composePath: string) {
  return crypto.createHash("sha256").update(`${commitSha}\0${composePath}\0${env}`).digest("hex")
}

export async function recordDeployedCommit(stackId: number, commit: CommitInfo, hash: string) {
  const db = await getDb()
  await db
    .updateTable("stack_git")
    .set({
      commit_sha: commit.sha,
      commit_subject: commit.subject.slice(0, 1000),
      commit_author: commit.author.slice(0, 255),
      commit_date: commit.date.slice(0, 40),
      deployed_hash: hash,
    })
    .where("stack_id", "=", stackId)
    .execute()
}

/** A new random webhook secret. */
export function newWebhookSecret() {
  return crypto.randomBytes(32).toString("base64url")
}

/** Enables the webhook (new opaque id unless it has one) with a new secret; returns the secret. */
export async function setWebhook(stackId: number, opts: { keepId: boolean }): Promise<{ id: string; secret: string }> {
  const db = await getDb()
  const row = await getStackGit(stackId)
  if (!row) throw new Error("Not a Git stack")
  const id = opts.keepId && row.webhook_id ? row.webhook_id : crypto.randomBytes(24).toString("base64url")
  const secret = newWebhookSecret()
  await db
    .updateTable("stack_git")
    .set({ webhook_id: id, webhook_secret: encryptSecret(secret, webhookContext(stackId)) })
    .where("stack_id", "=", stackId)
    .execute()
  return { id, secret }
}

export async function disableWebhook(stackId: number) {
  const db = await getDb()
  await db.updateTable("stack_git").set({ webhook_id: null, webhook_secret: null }).where("stack_id", "=", stackId).execute()
}

export async function findByWebhookId(hookId: string): Promise<StackGit | undefined> {
  const db = await getDb()
  return db.selectFrom("stack_git").selectAll().where("webhook_id", "=", hookId).executeTakeFirst()
}

/** The webhook secret in clear (server only), or null when it can't be decrypted. */
export function webhookSecret(row: StackGit): string | null {
  if (!row.webhook_secret) return null
  try {
    return decryptSecret(row.webhook_secret, webhookContext(row.stack_id))
  } catch {
    return null
  }
}

export async function listPolledStacks(): Promise<StackGit[]> {
  const db = await getDb()
  return db.selectFrom("stack_git").selectAll().where("poll_minutes", ">", 0).execute()
}

export async function markChecked(stackId: number, at = new Date().toISOString()) {
  const db = await getDb()
  await db.updateTable("stack_git").set({ last_checked_at: at }).where("stack_id", "=", stackId).execute()
}
