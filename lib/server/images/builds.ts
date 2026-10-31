import "server-only"

import { getDb } from "@/lib/server/db"
import type { ImageBuildStatus } from "@/lib/server/db/schema"
import type { BuildOptions, BuildSource, BuildStatus } from "@/lib/image-build"

// Build history (table image_builds, migration 016). One row per build,
// written when it starts and completed when it ends. Never holds
// credentials: Git logins are used for the clone only, uploaded archives
// aren't kept (only their name), and registry logins never enter the log.

/** Builds kept per environment; older ones are deleted when a new one starts. */
export const BUILDS_KEPT = 100
/** Characters of build output kept (the end; earlier output is cut). */
export const MAX_STORED_LOG = 512 * 1024

/** Builds running in this process: a "running" row that isn't here was interrupted (restart). */
const active = new Set<number>()

export function markActive(id: number) {
  active.add(id)
}
export function markDone(id: number) {
  active.delete(id)
}
export function activeBuildCount() {
  return active.size
}

export type BuildSummary = {
  id: number
  username: string
  sourceKind: BuildSource["kind"]
  sourceSummary: string
  tags: string[]
  /** "interrupted": the server stopped while it ran. */
  status: BuildStatus | "interrupted"
  error: string | null
  imageId: string | null
  startedAt: string
  finishedAt: string | null
}

export type BuildRecord = BuildSummary & { log: string; source: BuildSource; options: BuildOptions }

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

type Row = {
  id: number
  username: string
  source_kind: string
  source_summary: string
  tags: string
  status: ImageBuildStatus
  error: string | null
  image_id: string | null
  started_at: string
  finished_at: string | null
}

function toSummary(r: Row): BuildSummary {
  const id = Number(r.id)
  return {
    id,
    username: r.username,
    sourceKind: r.source_kind as BuildSource["kind"],
    sourceSummary: r.source_summary,
    tags: parseJson<string[]>(r.tags, []),
    status: r.status === "running" && !active.has(id) ? "interrupted" : r.status,
    error: r.error,
    imageId: r.image_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }
}

const SUMMARY_COLUMNS = [
  "id",
  "username",
  "source_kind",
  "source_summary",
  "tags",
  "status",
  "error",
  "image_id",
  "started_at",
  "finished_at",
] as const

export async function insertBuild(values: {
  environmentId: number
  user: { id: number | null; username: string }
  source: BuildSource
  sourceSummary: string
  options: BuildOptions
}): Promise<number> {
  const db = await getDb()
  const res = await db
    .insertInto("image_builds")
    .values({
      environment_id: values.environmentId,
      user_id: values.user.id,
      username: values.user.username.slice(0, 64),
      source_kind: values.source.kind,
      source_summary: values.sourceSummary.slice(0, 1000),
      source: JSON.stringify(values.source),
      options: JSON.stringify(values.options),
      tags: JSON.stringify(values.options.tags),
      status: "running",
      started_at: new Date().toISOString(),
    })
    .executeTakeFirstOrThrow()
  const id = Number(res.insertId)
  // Keep the newest BUILDS_KEPT of this environment.
  const cutoff = await db
    .selectFrom("image_builds")
    .select("id")
    .where("environment_id", "=", values.environmentId)
    .orderBy("id", "desc")
    .offset(BUILDS_KEPT)
    .limit(1)
    .executeTakeFirst()
  if (cutoff) {
    await db
      .deleteFrom("image_builds")
      .where("environment_id", "=", values.environmentId)
      .where("id", "<=", Number(cutoff.id))
      .execute()
  }
  return id
}

export async function finishBuild(
  id: number,
  values: { status: Exclude<ImageBuildStatus, "running">; imageId?: string | null; error?: string | null; log: string }
) {
  const db = await getDb()
  await db
    .updateTable("image_builds")
    .set({
      status: values.status,
      image_id: values.imageId ?? null,
      error: values.error ? values.error.slice(0, 2000) : null,
      log: values.log,
      finished_at: new Date().toISOString(),
    })
    .where("id", "=", id)
    .execute()
}

export async function listBuilds(environmentId: number, limit = 25): Promise<BuildSummary[]> {
  const db = await getDb()
  const rows = await db
    .selectFrom("image_builds")
    .select(SUMMARY_COLUMNS)
    .where("environment_id", "=", environmentId)
    .orderBy("id", "desc")
    .limit(limit)
    .execute()
  return rows.map(toSummary)
}

/** A build of this environment with its log, or null. */
export async function getBuild(environmentId: number, id: number): Promise<BuildRecord | null> {
  const db = await getDb()
  const row = await db
    .selectFrom("image_builds")
    .select([...SUMMARY_COLUMNS, "log", "source", "options"])
    .where("environment_id", "=", environmentId)
    .where("id", "=", id)
    .executeTakeFirst()
  if (!row) return null
  return {
    ...toSummary(row),
    log: row.log ?? "",
    source: parseJson<BuildSource>(row.source, { kind: "upload", filename: "?", dockerfile: "Dockerfile" }),
    options: parseJson<BuildOptions>(row.options, {
      tags: [],
      buildArgs: {},
      labels: {},
      target: "",
      noCache: false,
      pull: false,
      push: false,
    }),
  }
}
