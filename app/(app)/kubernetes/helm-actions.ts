"use server"

import { z } from "zod"

import {
  chartNameSchema,
  chartVersionSchema,
  checkRepoCredentials,
  checkValuesYaml,
  releaseNameSchema,
  repoNameSchema,
  timeoutSchema,
  validateOciRef,
  validateRepoUrl,
  type ChartSource,
  type ChartVersion,
} from "@/lib/kubernetes/helm-charts"
import { namespaceSchema } from "@/lib/kubernetes/names"
import { authorize, inEnvironment, runAction, UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import { getKube, KubeError } from "@/lib/server/kubernetes"
import { uninstallRelease } from "@/lib/server/kubernetes/helm"
import { helmVersion } from "@/lib/server/kubernetes/helm-cli"
import {
  checkRepository,
  dropIndex,
  helmUninstall,
  listChartVersions,
  listRepoCharts,
  showChartValues,
  startInstall,
  startRollback,
  startUpgrade,
  type HelmOperationInfo,
  type OperationContext,
} from "@/lib/server/kubernetes/helm-operations"
import { deleteHelmRepo, findHelmRepoByName, getHelmRepo, helmRepoForOciRef, insertHelmRepo } from "@/lib/server/kubernetes/helm-repos"
import { kubeTarget } from "@/lib/server/kubernetes/target"
import type { ActionState } from "@/lib/validation"

// Helm: chart repositories (administrators; they hold credentials used on
// every cluster) and install / upgrade / rollback / uninstall (manager role
// in the cluster). Values, manifests and NOTES can contain secrets, so the
// current values are only read and shown for administrators, like on the
// release page.

const envIdSchema = z.number().int().positive()

// ------------------------------------------------------------ repositories

/** FormDialog action: name, url, username, password. */
export async function addHelmRepository(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const name = repoNameSchema.safeParse(formData.get("name") ?? "")
  const username = String(formData.get("username") ?? "").trim()
  const password = String(formData.get("password") ?? "")
  const errors: Record<string, string[]> = {}
  if (!name.success) errors.name = [name.error.issues[0]?.message ?? "Invalid name"]
  const credError = checkRepoCredentials(username, password)
  if (credError) errors[username ? "password" : "username"] = [credError]
  const url = validateRepoUrl(String(formData.get("url") ?? ""), { withCredentials: Boolean(username || password) })
  if (!url.ok) errors.url = [url.error]
  if (Object.keys(errors).length || !name.success || !url.ok) return { error: "Please fix the highlighted fields", fieldErrors: errors }

  return runAction("admin", "kubernetes.helm.repo.add", `${name.data} (${url.value.url})`, async () => {
    if (await findHelmRepoByName(name.data)) throw new UserError(`A repository named "${name.data}" exists already`)
    const credentials = username ? { username, password } : null
    // Index repositories are checked by downloading their index; registries can't be listed.
    try {
      await checkRepository({ name: name.data, url: url.value.url, credentials, oci: url.value.oci })
    } catch (err) {
      if (err instanceof KubeError) throw new UserError(err.message)
      throw err
    }
    await insertHelmRepo({ name: name.data, url: url.value.url, credentials })
    return `Repository ${name.data} added`
  })
}

export async function removeHelmRepository(id: number): Promise<ActionState> {
  if (!Number.isSafeInteger(id) || id < 1) return { error: "Invalid repository" }
  const repo = await getHelmRepo(id).catch(() => null)
  return runAction("admin", "kubernetes.helm.repo.remove", repo?.name ?? String(id), async () => {
    if (!repo) throw new UserError("The repository no longer exists")
    await deleteHelmRepo(id)
    await dropIndex(repo.name)
    return `Repository ${repo.name} removed`
  })
}

// ----------------------------------------------------------------- queries

type QueryResult<T> = { data: T; error?: never } | { data?: never; error: string }

async function query<T>(environmentId: number, fn: (isAdmin: boolean) => Promise<T>): Promise<QueryResult<T>> {
  if (!envIdSchema.safeParse(environmentId).success) return { error: "Invalid environment" }
  const auth = await authorize(inEnvironment("manage", environmentId))
  if ("error" in auth) return { error: auth.error }
  try {
    return { data: await fn(auth.user.role === "admin") }
  } catch (err) {
    if (err instanceof KubeError || err instanceof UserError) return { error: err.message }
    console.error("[gantry] helm query failed", err)
    return { error: "Something went wrong. Check the server logs." }
  }
}

const sourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("repo"), repoId: z.number().int().positive(), chart: chartNameSchema }),
  z.object({ type: z.literal("oci"), ref: z.string().max(2048) }),
])

/**
 * The chart source of a request. Typed oci:// references make the server
 * contact that registry, so for non-administrators they must lie under an
 * OCI repository an administrator added (no arbitrary hosts).
 */
async function parseSource(input: unknown, isAdmin: boolean): Promise<ChartSource> {
  const parsed = sourceSchema.safeParse(input)
  if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Pick a chart")
  if (parsed.data.type === "oci") {
    const ref = validateOciRef(parsed.data.ref)
    if (!ref.ok) throw new UserError(ref.error)
    if (!isAdmin) {
      const repo = await helmRepoForOciRef(ref.value)
      if (!repo || !ref.value.startsWith(`${repo.url}/`)) {
        throw new UserError("Only administrators can install from OCI registries that aren't added as chart repositories")
      }
    }
    return { type: "oci", ref: ref.value }
  }
  return parsed.data
}

function parseVersion(input: unknown): string {
  const v = chartVersionSchema.safeParse(input ?? "")
  if (!v.success) throw new UserError(v.error.issues[0]?.message ?? "Invalid version")
  return v.data
}

export async function listHelmCharts(environmentId: number, repoId: number, refresh = false): Promise<QueryResult<ChartVersion[]>> {
  return query(environmentId, () => {
    if (!Number.isSafeInteger(repoId) || repoId < 1) throw new UserError("Pick a repository")
    return listRepoCharts(repoId, refresh)
  })
}

export async function listHelmChartVersions(environmentId: number, repoId: number, chart: string): Promise<QueryResult<ChartVersion[]>> {
  return query(environmentId, () => {
    if (!Number.isSafeInteger(repoId) || repoId < 1) throw new UserError("Pick a repository")
    const name = chartNameSchema.safeParse(chart)
    if (!name.success) throw new UserError("Invalid chart name")
    return listChartVersions(repoId, name.data)
  })
}

/** The chart's default values (public: part of the chart). */
export async function loadHelmChartValues(environmentId: number, source: ChartSource, version: string): Promise<QueryResult<string>> {
  return query(environmentId, async (isAdmin) => showChartValues(await parseSource(source, isAdmin), parseVersion(version)))
}

// -------------------------------------------------------------- operations

export type HelmOperationState = ActionState & { operation?: HelmOperationInfo }

const optionsSchema = z.object({
  wait: z.boolean(),
  atomic: z.boolean(),
  timeoutMinutes: timeoutSchema,
})

const releaseRefSchema = z.object({
  environmentId: envIdSchema,
  namespace: namespaceSchema,
  release: releaseNameSchema,
})

type ReleaseRef = z.infer<typeof releaseRefSchema>

function parse<T>(schema: z.ZodType<T>, input: unknown): { data: T; error?: never } | { data?: never; error: string } {
  const parsed = schema.safeParse(input)
  if (parsed.success) return { data: parsed.data }
  const issue = parsed.error.issues[0]
  return { error: issue ? `${issue.path.join(".") || "input"}: ${issue.message}` : "Invalid input" }
}

async function operationContext(ref: ReleaseRef, user: { id: number; username: string; role: "admin" | "user" }, failedAction: string): Promise<OperationContext> {
  const { env } = await getKube(ref.environmentId)
  return {
    userId: user.id,
    environmentId: env.id,
    target: kubeTarget(env),
    namespace: ref.namespace,
    release: ref.release,
    onFinish: async (result) => {
      if (!result.ok) await audit(user, failedAction, `${ref.namespace}/${ref.release}: ${result.message}`.slice(0, 250))
    },
  }
}

/** Starts `helm install`; the output is followed through the returned operation. */
export async function installHelmChart(input: {
  environmentId: number
  namespace: string
  release: string
  source: ChartSource
  version: string
  values: string
  createNamespace: boolean
  wait: boolean
  atomic: boolean
  timeoutMinutes: number
}): Promise<HelmOperationState> {
  const ref = parse(releaseRefSchema, input)
  if (ref.error !== undefined) return { error: ref.error }
  const opts = parse(optionsSchema, input)
  if (opts.error !== undefined) return { error: opts.error }
  const values = checkValuesYaml(typeof input.values === "string" ? input.values : "")
  if (!values.ok) return { error: values.error, fieldErrors: { values: [values.error] } }

  let operation: HelmOperationInfo | undefined
  const label = input.source?.type === "oci" ? input.source.ref : `${input.source?.chart ?? ""}`
  const res = await runAction(
    inEnvironment("manage", ref.data.environmentId),
    "kubernetes.helm.install",
    `${ref.data.namespace}/${ref.data.release} (${label}${input.version ? ` ${input.version}` : ""})`.slice(0, 250),
    async ({ user }) => {
      const source = await parseSource(input.source, user.role === "admin")
      const version = parseVersion(input.version)
      const ctx = await operationContext(ref.data, user, "kubernetes.helm.install.failed")
      operation = await startInstall(ctx, {
        source,
        version,
        values: values.value,
        createNamespace: input.createNamespace === true,
        ...opts.data,
        hideNotes: user.role !== "admin",
      })
      return `Installing ${ref.data.release}…`
    }
  )
  return { ...res, operation }
}

/**
 * Starts `helm upgrade`. Administrators send the complete values (the
 * editor is prefilled with the current ones); for everyone else the
 * current values are kept as they are (--reset-then-reuse-values).
 */
export async function upgradeHelmRelease(input: {
  environmentId: number
  namespace: string
  release: string
  source: ChartSource
  version: string
  values: string | null
  wait: boolean
  atomic: boolean
  timeoutMinutes: number
}): Promise<HelmOperationState> {
  const ref = parse(releaseRefSchema, input)
  if (ref.error !== undefined) return { error: ref.error }
  const opts = parse(optionsSchema, input)
  if (opts.error !== undefined) return { error: opts.error }

  let operation: HelmOperationInfo | undefined
  const res = await runAction(
    inEnvironment("manage", ref.data.environmentId),
    "kubernetes.helm.upgrade",
    `${ref.data.namespace}/${ref.data.release}${input.version ? ` → ${input.version}` : ""}`.slice(0, 250),
    async ({ user }) => {
      let values: string | null = null
      if (user.role === "admin" && typeof input.values === "string") {
        const checked = checkValuesYaml(input.values)
        if (!checked.ok) throw new UserError(`Values: ${checked.error}`)
        values = checked.value
      }
      const source = await parseSource(input.source, user.role === "admin")
      const version = parseVersion(input.version)
      const ctx = await operationContext(ref.data, user, "kubernetes.helm.upgrade.failed")
      operation = await startUpgrade(ctx, { source, version, values, ...opts.data, hideNotes: user.role !== "admin" })
      return `Upgrading ${ref.data.release}…`
    }
  )
  return { ...res, operation }
}

export async function rollbackHelmRelease(input: {
  environmentId: number
  namespace: string
  release: string
  revision: number
  wait: boolean
  timeoutMinutes: number
}): Promise<HelmOperationState> {
  const ref = parse(releaseRefSchema, input)
  if (ref.error !== undefined) return { error: ref.error }
  const opts = parse(optionsSchema.omit({ atomic: true }).extend({ revision: z.number().int().positive() }), input)
  if (opts.error !== undefined) return { error: opts.error }

  let operation: HelmOperationInfo | undefined
  const res = await runAction(
    inEnvironment("manage", ref.data.environmentId),
    "kubernetes.helm.rollback",
    `${ref.data.namespace}/${ref.data.release} → revision ${opts.data.revision}`,
    async ({ user }) => {
      const ctx = await operationContext(ref.data, user, "kubernetes.helm.rollback.failed")
      operation = await startRollback(ctx, opts.data)
      return `Rolling ${ref.data.release} back to revision ${opts.data.revision}…`
    }
  )
  return { ...res, operation }
}

/**
 * `helm uninstall` (hooks run, history removed). Without the helm CLI on
 * the server, falls back to deleting the manifest's objects and the
 * release records directly (no hooks).
 */
export async function uninstallHelmRelease(input: { environmentId: number; namespace: string; name: string }): Promise<ActionState> {
  const ref = parse(releaseRefSchema, { ...input, release: input?.name })
  if (ref.error !== undefined) return { error: "Invalid release" }
  const r = ref.data
  return runAction(inEnvironment("manage", r.environmentId), "kubernetes.helm.uninstall", `${r.namespace}/${r.release}`, async () => {
    const { env, api } = await getKube(r.environmentId)
    if (await helmVersion()) {
      const res = await helmUninstall({ environmentId: env.id, target: kubeTarget(env), namespace: r.namespace, release: r.release })
      if (!res.ok) throw new UserError(res.message)
      return res.message
    }
    const res = await uninstallRelease(api, r.namespace, r.release)
    if (res.failed.length) {
      throw new UserError(`Some objects could not be deleted, so the release was kept: ${res.failed.join("; ")}`)
    }
    const kept = res.kept.length ? ` (kept by resource policy: ${res.kept.join(", ")})` : ""
    return `Release ${r.release} uninstalled without hooks (helm CLI not available): ${res.deleted} object(s) deleted${kept}`
  })
}
