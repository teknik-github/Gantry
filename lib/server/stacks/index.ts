import "server-only"

import { getDb } from "@/lib/server/db"
import type { Stack, StackRunStatus } from "@/lib/server/db/schema"
import type { ContainerSummary } from "@/lib/server/docker/api"
import type { DockerTarget } from "@/lib/server/docker/client"
import {
  operationCommands,
  runCompose,
  stackDir,
  writeStackFiles,
  type ComposeRun,
  type StackOperation,
} from "@/lib/server/stacks/compose"

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

/**
 * Writes the stack's files, runs the operation's compose commands against
 * `target` and stores the output as the stack's last run.
 */
export async function runStackOperation(
  stack: Pick<Stack, "id" | "environment_id" | "name" | "compose" | "env">,
  target: DockerTarget,
  op: StackOperation,
  username: string,
  opts: { removeVolumes?: boolean } = {}
): Promise<ComposeRun> {
  if (locks.has(stack.id)) throw new StackBusyError()
  locks.add(stack.id)
  try {
    const dir = stackDir(stack.environment_id, stack.name)
    await writeStackFiles(dir, stack.compose, stack.env)
    const run = await runCompose({
      target,
      project: stack.name,
      cwd: dir,
      commands: operationCommands(op, opts),
      timeoutMs: TIMEOUTS[op],
    })
    await recordRun(stack.id, op, run.code === 0 ? "success" : "error", run.output, username)
    return run
  } finally {
    locks.delete(stack.id)
  }
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
