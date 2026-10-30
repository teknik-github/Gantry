import "server-only"

import { shortSha } from "@/lib/git-stacks"
import { getDb } from "@/lib/server/db"
import type { Stack, StackGit, StackRunStatus } from "@/lib/server/db/schema"
import type { ContainerSummary } from "@/lib/server/docker/api"
import type { DockerTarget } from "@/lib/server/docker/client"
import { notify } from "@/lib/server/notifications"
import { allRegistryCredentials } from "@/lib/server/registries"
import {
  ENV_FILE,
  operationCommands,
  OutputBuffer,
  runCompose,
  stackDir,
  writeEnvFile,
  writeStackFiles,
  type ComposeRun,
  type StackOperation,
} from "@/lib/server/stacks/compose"
import { GitError, hasCheckout, headCommit, readComposeFile, syncCheckout, type CommitInfo } from "@/lib/server/stacks/git"
import {
  deployFingerprint,
  getStackGit,
  GitCredentialsError,
  gitSource,
  recordDeployedCommit,
} from "@/lib/server/stacks/git-records"
import { validateCompose } from "@/lib/stacks"

export const PROJECT_LABEL = "com.docker.compose.project"
export const SERVICE_LABEL = "com.docker.compose.service"
export const CONFIG_FILES_LABEL = "com.docker.compose.project.config_files"
export const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir"

const TIMEOUTS: Record<StackOperation, number> = {
  deploy: 15 * 60_000,
  redeploy: 20 * 60_000,
  start: 5 * 60_000,
  stop: 5 * 60_000,
  restart: 5 * 60_000,
  down: 5 * 60_000,
}

export async function listStacks(environmentId: number): Promise<Stack[]> {
  const db = await getDb()
  return db.selectFrom("stacks").selectAll().where("environment_id", "=", environmentId).orderBy("name").execute()
}

export async function getStack(id: number): Promise<Stack | undefined> {
  const db = await getDb()
  return db.selectFrom("stacks").selectAll().where("id", "=", id).executeTakeFirst()
}

export async function findStackByName(environmentId: number, name: string) {
  const db = await getDb()
  return db
    .selectFrom("stacks")
    .select("id")
    .where("environment_id", "=", environmentId)
    .where("name", "=", name)
    .executeTakeFirst()
}

export async function insertStack(values: {
  environment_id: number
  name: string
  compose: string
  env: string
  created_by: string
}): Promise<number> {
  const db = await getDb()
  const now = new Date().toISOString()
  // No RETURNING on MySQL; both drivers report insertId.
  const res = await db
    .insertInto("stacks")
    .values({ ...values, created_at: now, updated_at: now })
    .executeTakeFirstOrThrow()
  return Number(res.insertId)
}

export async function updateStackContent(id: number, compose: string, env: string) {
  const db = await getDb()
  await db
    .updateTable("stacks")
    .set({ compose, env, updated_at: new Date().toISOString() })
    .where("id", "=", id)
    .execute()
}

export async function deleteStackRecord(id: number) {
  const db = await getDb()
  await db.deleteFrom("stacks").where("id", "=", id).execute()
}

async function recordRun(id: number, action: string, status: StackRunStatus, output: string, username: string) {
  const db = await getDb()
  await db
    .updateTable("stacks")
    .set({
      last_action: action,
      last_status: status,
      last_output: output,
      last_run_at: new Date().toISOString(),
      last_run_by: username,
    })
    .where("id", "=", id)
    .execute()
}

// One compose run per stack at a time (per Gantry process).
const globalForLocks = globalThis as unknown as { __gantryStackLocks?: Set<number> }
const locks = (globalForLocks.__gantryStackLocks ??= new Set<number>())

export class StackBusyError extends Error {
  constructor() {
    super("Another operation is already running on this stack. Wait for it to finish.")
  }
}

/** Runs `fn` holding the stack's lock; throws StackBusyError if it's taken. */
export async function withStackLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
  if (locks.has(id)) throw new StackBusyError()
  locks.add(id)
  try {
    return await fn()
  } finally {
    locks.delete(id)
  }
}

export type StackRun = ComposeRun & {
  /** Git stacks: "Pull & redeploy" found the same commit and .env as the last deploy. */
  skipped?: boolean
  /** Git stacks: the commit the operation ran with. */
  commit?: CommitInfo | null
}

type StackFields = Pick<Stack, "id" | "environment_id" | "name" | "compose" | "env">

/**
 * Writes the stack's files, runs the operation's compose commands against
 * `target` and stores the output as the stack's last run. Git stacks run
 * from their checkout instead (see runGitOperation).
 */
export async function runStackOperation(
  stack: StackFields,
  target: DockerTarget,
  op: StackOperation,
  username: string,
  opts: { removeVolumes?: boolean; force?: boolean } = {}
): Promise<StackRun> {
  return withStackLock(stack.id, async () => {
    const git = await getStackGit(stack.id)
    if (git) return runGitOperation(stack, git, target, op, username, opts)
    const dir = stackDir(stack.environment_id, stack.name)
    await writeStackFiles(dir, stack.compose, stack.env)
    const run = await runCompose({
      target,
      project: stack.name,
      cwd: dir,
      commands: operationCommands(op, opts),
      timeoutMs: TIMEOUTS[op],
      registries: await allRegistryCredentials(),
    })
    await recordRun(stack.id, op, run.code === 0 ? "success" : "error", run.output, username)
    return run
  })
}

/**
 * Git stacks. "redeploy" fetches the ref first and is skipped when neither
 * the commit nor the .env changed since the last successful deploy (unless
 * forced); the other operations use the current checkout (fetched first if
 * it's missing). Deploys record the commit and raise a `stack_deploy` alert.
 */
async function runGitOperation(
  stack: StackFields,
  git: StackGit,
  target: DockerTarget,
  op: StackOperation,
  username: string,
  opts: { removeVolumes?: boolean; force?: boolean }
): Promise<StackRun> {
  const dir = stackDir(stack.environment_id, stack.name)
  const out = new OutputBuffer()
  const failed = async (message: string): Promise<StackRun> => {
    out.append(`${message}\n`)
    const run = { code: 1, output: out.toString(), timedOut: false, commit: null }
    await recordRun(stack.id, op, "error", run.output, username)
    if (op === "deploy" || op === "redeploy") await notifyGitDeploy(stack, op, run, null, username)
    return run
  }

  let commit: CommitInfo
  let composeFile: string
  try {
    await writeEnvFile(dir, stack.env)
    commit =
      op === "redeploy" || !(await hasCheckout(dir))
        ? await syncCheckout(dir, gitSource(git), out)
        : await headCommit(dir)
    const file = await readComposeFile(dir, git.compose_path)
    composeFile = file.file
    // Keep a copy for the pages (services list, templates, non-admin view).
    if (file.text !== stack.compose) await storeComposeSnapshot(stack.id, file.text)
    if (op === "deploy" || op === "redeploy") {
      const check = validateCompose(file.text)
      if (!check.ok) return failed(`${git.compose_path}: ${check.error}`)
    }
  } catch (err) {
    if (err instanceof GitError || err instanceof GitCredentialsError) return failed(err.message)
    throw err
  }

  const hash = deployFingerprint(commit.sha, stack.env, git.compose_path)
  if (op === "redeploy" && !opts.force && git.deployed_hash === hash) {
    // Not recorded as a run: the last deploy's output stays on the page.
    return { code: 0, output: out.toString(), timedOut: false, skipped: true, commit }
  }

  const run = await runCompose({
    target,
    project: stack.name,
    cwd: dir,
    files: { compose: composeFile, env: ENV_FILE },
    commands: operationCommands(op, opts),
    timeoutMs: TIMEOUTS[op],
    registries: await allRegistryCredentials(),
    out,
  })
  await recordRun(stack.id, op, run.code === 0 ? "success" : "error", run.output, username)
  if (op === "deploy" || op === "redeploy") {
    if (run.code === 0) await recordDeployedCommit(stack.id, commit, hash)
    await notifyGitDeploy(stack, op, run, commit, username)
  }
  return { ...run, commit }
}

async function storeComposeSnapshot(id: number, compose: string) {
  const db = await getDb()
  // Not an edit: updated_at stays.
  await db.updateTable("stacks").set({ compose }).where("id", "=", id).execute()
}

async function notifyGitDeploy(
  stack: StackFields,
  op: StackOperation,
  run: ComposeRun,
  commit: CommitInfo | null,
  username: string
) {
  const db = await getDb()
  const env = await db.selectFrom("environments").select("name").where("id", "=", stack.environment_id).executeTakeFirst()
  const at = commit ? ` at ${shortSha(commit.sha)}` : ""
  const ok = run.code === 0
  const tail = run.output.trim().split("\n").slice(-8).join("\n")
  await notify(
    {
      kind: "stack_deploy",
      environment: env?.name ?? `#${stack.environment_id}`,
      subject: ok ? `${stack.name} deployed${at}` : `${stack.name} failed to deploy${at}`,
      message: [
        commit ? `Commit ${shortSha(commit.sha)} ${commit.subject} (${commit.author})` : null,
        `${op === "redeploy" ? "Pull & redeploy" : "Deploy"} by ${username}`,
        ok ? null : tail,
      ]
        .filter(Boolean)
        .join("\n"),
    },
    stack.environment_id
  )
}

export function isStackBusy(id: number) {
  return locks.has(id)
}

/** Containers grouped by compose project label. */
export function groupByProject(containers: ContainerSummary[]) {
  const projects = new Map<string, ContainerSummary[]>()
  for (const c of containers) {
    const project = c.Labels?.[PROJECT_LABEL]
    if (!project) continue
    const list = projects.get(project) ?? []
    list.push(c)
    projects.set(project, list)
  }
  return projects
}
