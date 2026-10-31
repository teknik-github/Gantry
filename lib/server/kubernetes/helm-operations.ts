import "server-only"

import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import type { ChartSource, ChartVersion } from "@/lib/kubernetes/helm-charts"
import type { KubeTarget } from "@/lib/server/kubernetes/client"
import {
  helmErrorMessage,
  HelmError,
  helmHome,
  helmVersion,
  HELM_MISSING,
  lockRelease,
  runHelm,
  withHelmWorkspace,
  withQuerySlot,
  type HelmWorkspace,
  type WorkspaceOptions,
} from "@/lib/server/kubernetes/helm-cli"
import { getHelmRepo, helmRepoForOciRef, ociHost, type HelmRepo } from "@/lib/server/kubernetes/helm-repos"

// Helm commands Gantry runs, and the registry of running operations whose
// output the browser follows (/api/kubernetes/helm/operations/<id>).

const QUERY_TIMEOUT_MS = 90_000
/** Grace on top of helm's own --timeout before the process is killed. */
const KILL_GRACE_MS = 2 * 60_000
/** Output kept per operation. */
const MAX_OPERATION_OUTPUT = 512 * 1024
/** Finished operations are forgotten after this long. */
const KEEP_FINISHED_MS = 30 * 60_000
const MAX_KEPT_OPERATIONS = 200
/** A repository index older than this is downloaded again before use. */
const INDEX_MAX_AGE_MS = 5 * 60_000

// ------------------------------------------------------------- chart refs

/** A resolved chart: the reference helm gets plus the workspace it needs. */
type ResolvedChart = { ref: string; workspace: WorkspaceOptions; repo: HelmRepo | null; label: string }

export async function resolveChart(source: ChartSource): Promise<ResolvedChart> {
  if (source.type === "oci") {
    const repo = await helmRepoForOciRef(source.ref)
    return {
      ref: source.ref,
      workspace: { oci: { host: ociHost(source.ref), credentials: repo?.credentials ?? null } },
      repo: null,
      label: source.ref,
    }
  }
  const repo = await getHelmRepo(source.repoId)
  if (!repo) throw new HelmError("The chart repository no longer exists", 404)
  if (repo.oci) {
    const ref = `${repo.url}/${source.chart}`
    return { ref, workspace: { oci: { host: ociHost(repo.url), credentials: repo.credentials } }, repo: null, label: ref }
  }
  return { ref: `${repo.name}/${source.chart}`, workspace: { repo }, repo, label: `${repo.name}/${source.chart}` }
}

const indexUpdates = new Map<string, Promise<void>>()

/** Downloads a repository's index into the shared cache unless a recent one is there. */
async function ensureIndex(ws: HelmWorkspace, repo: Pick<HelmRepo, "name">, force = false): Promise<void> {
  const file = path.join(helmHome().repositoryCache, `${repo.name}-index.yaml`)
  if (!force) {
    const st = await fs.stat(/* turbopackIgnore: true */ file).catch(() => null)
    if (st && Date.now() - st.mtimeMs < INDEX_MAX_AGE_MS) return
  }
  let pending = indexUpdates.get(repo.name)
  if (!pending) {
    pending = (async () => {
      const res = await runHelm(ws, ["repo", "update", repo.name, "--fail-on-repo-update-fail"], { timeoutMs: QUERY_TIMEOUT_MS })
      if (res.code !== 0) throw new HelmError(helmErrorMessage(res, `Downloading the index of ${repo.name}`))
    })().finally(() => indexUpdates.delete(repo.name))
    indexUpdates.set(repo.name, pending)
  }
  await pending
}

/** Forgets a repository's cached index (after it was removed). */
export async function dropIndex(name: string) {
  const dir = helmHome().repositoryCache
  await Promise.all(
    [`${name}-index.yaml`, `${name}-charts.txt`].map((f) => fs.rm(/* turbopackIgnore: true */ path.join(dir, f), { force: true }))
  )
}

async function requireHelm() {
  if (!(await helmVersion())) throw new HelmError(HELM_MISSING, 503)
}

/** Checks a repository can be used: downloads its index (index repositories) . */
export async function checkRepository(repo: Pick<HelmRepo, "name" | "url" | "credentials" | "oci">): Promise<void> {
  if (repo.oci) return
  await requireHelm()
  await withQuerySlot(() => withHelmWorkspace({ repo }, (ws) => ensureIndex(ws, repo, true)))
}

type SearchRow = { name?: string; version?: string; app_version?: string; description?: string }

function parseSearch(stdout: string): SearchRow[] {
  try {
    const rows = JSON.parse(stdout || "[]")
    return Array.isArray(rows) ? rows : []
  } catch {
    throw new HelmError("helm search returned something that isn't JSON")
  }
}

/** Charts of an index repository (latest version of each). */
export async function listRepoCharts(repoId: number, refresh = false): Promise<ChartVersion[]> {
  await requireHelm()
  const repo = await getHelmRepo(repoId)
  if (!repo) throw new HelmError("The chart repository no longer exists", 404)
  if (repo.oci) return []
  return withQuerySlot(() =>
    withHelmWorkspace({ repo }, async (ws) => {
      await ensureIndex(ws, repo, refresh)
      const res = await runHelm(ws, ["search", "repo", `${repo.name}/`, "--output=json"], { timeoutMs: QUERY_TIMEOUT_MS })
      if (res.code !== 0) throw new HelmError(helmErrorMessage(res, "Listing charts"))
      const prefix = `${repo.name}/`
      return parseSearch(res.stdout)
        .filter((r) => r.name?.startsWith(prefix))
        .map((r) => ({
          name: r.name!.slice(prefix.length),
          version: r.version ?? "",
          appVersion: r.app_version ?? "",
          description: r.description ?? "",
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    })
  )
}

/** Versions of one chart of an index repository, newest first (as helm sorts them). */
export async function listChartVersions(repoId: number, chart: string): Promise<ChartVersion[]> {
  await requireHelm()
  const repo = await getHelmRepo(repoId)
  if (!repo) throw new HelmError("The chart repository no longer exists", 404)
  if (repo.oci) return []
  return withQuerySlot(() =>
    withHelmWorkspace({ repo }, async (ws) => {
      await ensureIndex(ws, repo)
      const full = `${repo.name}/${chart}`
      const res = await runHelm(ws, ["search", "repo", full, "--versions", "--devel", "--output=json"], { timeoutMs: QUERY_TIMEOUT_MS })
      if (res.code !== 0) throw new HelmError(helmErrorMessage(res, "Listing versions"))
      return parseSearch(res.stdout)
        .filter((r) => r.name === full)
        .map((r) => ({ name: chart, version: r.version ?? "", appVersion: r.app_version ?? "", description: r.description ?? "" }))
    })
  )
}

/** The chart's default values.yaml (`helm show values`). */
export async function showChartValues(source: ChartSource, version: string): Promise<string> {
  await requireHelm()
  const chart = await resolveChart(source)
  return withQuerySlot(() =>
    withHelmWorkspace(chart.workspace, async (ws) => {
      if (chart.repo) await ensureIndex(ws, chart.repo)
      const args = ["show", "values", chart.ref]
      if (version) args.push(`--version=${version}`)
      const res = await runHelm(ws, args, { timeoutMs: QUERY_TIMEOUT_MS })
      if (res.code !== 0) throw new HelmError(helmErrorMessage(res, "Loading the chart's values"))
      return res.stdout
    })
  )
}

// ------------------------------------------------------------- operations

export type HelmOperationKind = "install" | "upgrade" | "rollback"

export type HelmOperationEvent = { type: "output"; text: string } | { type: "done"; ok: boolean; message: string }

type Operation = {
  id: string
  userId: number
  environmentId: number
  kind: HelmOperationKind
  namespace: string
  release: string
  startedAt: number
  finishedAt?: number
  output: string
  dropped: number
  result?: { ok: boolean; message: string }
  listeners: Set<(event: HelmOperationEvent) => void>
}

export type HelmOperationInfo = Pick<Operation, "id" | "kind" | "namespace" | "release">

const globalForOps = globalThis as unknown as { __gantryHelmOps?: Map<string, Operation> }
const operations = (globalForOps.__gantryHelmOps ??= new Map())

function prune() {
  const now = Date.now()
  for (const [id, op] of operations) {
    if (op.finishedAt && now - op.finishedAt > KEEP_FINISHED_MS) operations.delete(id)
  }
  if (operations.size > MAX_KEPT_OPERATIONS) {
    const finished = [...operations.values()].filter((o) => o.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!)
    for (const o of finished.slice(0, operations.size - MAX_KEPT_OPERATIONS)) operations.delete(o.id)
  }
}

function append(op: Operation, text: string) {
  if (!text) return
  op.output += text
  if (op.output.length > MAX_OPERATION_OUTPUT) {
    const cut = op.output.length - MAX_OPERATION_OUTPUT
    op.output = op.output.slice(cut)
    op.dropped += cut
  }
  for (const l of op.listeners) l({ type: "output", text })
}

/** An operation of `userId` (others can't follow it). */
export function getOperation(id: string, userId: number) {
  const op = operations.get(id)
  if (!op || op.userId !== userId) return null
  return {
    info: { id: op.id, kind: op.kind, namespace: op.namespace, release: op.release },
    /** What was printed so far, then every new event until done. Returns the unsubscribe function. */
    follow(listener: (event: HelmOperationEvent) => void): () => void {
      const head = op.dropped ? `[… ${op.dropped} earlier characters dropped …]\n${op.output}` : op.output
      if (head) listener({ type: "output", text: head })
      if (op.result) {
        listener({ type: "done", ...op.result })
        return () => {}
      }
      op.listeners.add(listener)
      return () => op.listeners.delete(listener)
    },
  }
}

export type OperationContext = {
  userId: number
  environmentId: number
  target: KubeTarget
  namespace: string
  release: string
  /** Called once the command finished (audit of failures). */
  onFinish?: (result: { ok: boolean; message: string }) => void | Promise<void>
}

/**
 * Starts a mutating helm command in the background and returns its id.
 * The release stays locked until the command ends; the command can't
 * outlive its timeout.
 */
async function startOperation(
  kind: HelmOperationKind,
  ctx: OperationContext,
  workspace: WorkspaceOptions,
  prepare: (ws: HelmWorkspace) => Promise<{ args: string[]; timeoutMs: number; success: string }>
): Promise<HelmOperationInfo> {
  await requireHelm()
  const unlock = lockRelease(ctx.environmentId, ctx.namespace, ctx.release)
  prune()
  const op: Operation = {
    id: crypto.randomBytes(12).toString("base64url"),
    userId: ctx.userId,
    environmentId: ctx.environmentId,
    kind,
    namespace: ctx.namespace,
    release: ctx.release,
    startedAt: Date.now(),
    output: "",
    dropped: 0,
    listeners: new Set(),
  }
  operations.set(op.id, op)

  const finish = async (result: { ok: boolean; message: string }) => {
    op.result = result
    op.finishedAt = Date.now()
    unlock()
    for (const l of op.listeners) l({ type: "done", ...result })
    op.listeners.clear()
    try {
      await ctx.onFinish?.(result)
    } catch (err) {
      console.error("[gantry] helm operation follow-up failed", err)
    }
  }

  void withHelmWorkspace({ ...workspace, target: ctx.target, namespace: ctx.namespace }, async (ws) => {
    const { args, timeoutMs, success } = await prepare(ws)
    append(op, `$ helm ${args.filter((a) => !a.startsWith("--kubeconfig=")).map((a) => ws.redact(a)).join(" ")}\n`)
    const res = await runHelm(ws, [...args, ...ws.kubeArgs], { timeoutMs, onOutput: (t) => append(op, t) })
    if (res.timedOut) append(op, `\nStopped: no result after ${Math.round(timeoutMs / 1000)} s.\n`)
    return res.code === 0 ? { ok: true, message: success } : { ok: false, message: helmErrorMessage(res, `helm ${kind}`) }
  })
    .catch((err) => {
      if (!(err instanceof HelmError)) console.error(`[gantry] helm ${kind} failed`, err)
      const message = err instanceof HelmError ? err.message : `helm ${kind} failed unexpectedly`
      append(op, `${message}\n`)
      return { ok: false, message }
    })
    .then(finish)

  return { id: op.id, kind, namespace: ctx.namespace, release: ctx.release }
}

export type ReleaseOptions = {
  wait: boolean
  atomic: boolean
  timeoutMinutes: number
  /** Leave NOTES out of the output (they can print secrets; for non-administrators). */
  hideNotes: boolean
}

function commonFlags(o: ReleaseOptions, namespace: string) {
  const args = [`--namespace=${namespace}`, `--timeout=${o.timeoutMinutes}m`]
  if (o.wait || o.atomic) args.push("--wait")
  if (o.atomic) args.push("--atomic")
  if (o.hideNotes) args.push("--hide-notes")
  return args
}

const killAfter = (o: ReleaseOptions) => o.timeoutMinutes * 60_000 + KILL_GRACE_MS

export async function startInstall(
  ctx: OperationContext,
  input: { source: ChartSource; version: string; values: string; createNamespace: boolean } & ReleaseOptions
): Promise<HelmOperationInfo> {
  const chart = await resolveChart(input.source)
  return startOperation("install", ctx, chart.workspace, async (ws) => {
    if (chart.repo) await ensureIndex(ws, chart.repo)
    const args = ["install", ctx.release, chart.ref, ...commonFlags(input, ctx.namespace)]
    if (input.version) args.push(`--version=${input.version}`)
    if (input.createNamespace) args.push("--create-namespace")
    if (input.values.trim()) args.push(`--values=${await ws.write("values.yaml", input.values)}`)
    return { args, timeoutMs: killAfter(input), success: `Release ${ctx.release} installed from ${chart.label}` }
  })
}

export async function startUpgrade(
  ctx: OperationContext,
  input: {
    source: ChartSource
    version: string
    /** The complete user-supplied values; null keeps the current ones (--reset-then-reuse-values). */
    values: string | null
  } & ReleaseOptions
): Promise<HelmOperationInfo> {
  const chart = await resolveChart(input.source)
  return startOperation("upgrade", ctx, chart.workspace, async (ws) => {
    if (chart.repo) await ensureIndex(ws, chart.repo)
    const args = ["upgrade", ctx.release, chart.ref, ...commonFlags(input, ctx.namespace)]
    if (input.version) args.push(`--version=${input.version}`)
    if (input.values === null) args.push("--reset-then-reuse-values")
    else {
      args.push("--reset-values")
      if (input.values.trim()) args.push(`--values=${await ws.write("values.yaml", input.values)}`)
    }
    return { args, timeoutMs: killAfter(input), success: `Release ${ctx.release} upgraded to ${chart.label}${input.version ? ` ${input.version}` : ""}` }
  })
}

export async function startRollback(
  ctx: OperationContext,
  input: { revision: number } & Omit<ReleaseOptions, "atomic" | "hideNotes">
): Promise<HelmOperationInfo> {
  return startOperation("rollback", ctx, {}, async () => {
    const args = ["rollback", ctx.release, String(input.revision), `--namespace=${ctx.namespace}`, `--timeout=${input.timeoutMinutes}m`]
    if (input.wait) args.push("--wait")
    return {
      args,
      timeoutMs: input.timeoutMinutes * 60_000 + KILL_GRACE_MS,
      success: `Release ${ctx.release} rolled back to revision ${input.revision}`,
    }
  })
}

/**
 * `helm uninstall`, waited for (it is quick): runs hooks and deletes the
 * release's objects and history. Locked like the other operations.
 */
export async function helmUninstall(
  ctx: Omit<OperationContext, "userId" | "onFinish">,
  timeoutMinutes = 5
): Promise<{ ok: boolean; output: string; message: string }> {
  await requireHelm()
  const unlock = lockRelease(ctx.environmentId, ctx.namespace, ctx.release)
  try {
    return await withHelmWorkspace({ target: ctx.target, namespace: ctx.namespace }, async (ws) => {
      const args = ["uninstall", ctx.release, `--namespace=${ctx.namespace}`, `--timeout=${timeoutMinutes}m`, ...ws.kubeArgs]
      let output = ""
      const res = await runHelm(ws, args, { timeoutMs: timeoutMinutes * 60_000 + KILL_GRACE_MS, onOutput: (t) => (output += t) })
      return res.code === 0
        ? { ok: true, output, message: `Release ${ctx.release} uninstalled` }
        : { ok: false, output, message: helmErrorMessage(res, "helm uninstall") }
    })
  } finally {
    unlock()
  }
}
