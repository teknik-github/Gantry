"use server"

import { cookies } from "next/headers"
import { refresh } from "next/cache"
import { z } from "zod"

import { getI18n } from "@/lib/i18n/server"
import { MAX_MANIFEST_BYTES, parseManifest } from "@/lib/kubernetes/manifest"
import {
  MAX_REPLICAS,
  namespaceSchema,
  objectNameSchema,
  PROTECTED_NAMESPACES,
  WORKLOAD_KINDS,
  type WorkloadKind,
} from "@/lib/kubernetes/names"
import { inEnvironment, runAction, UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import { getCurrentUser } from "@/lib/server/auth/dal"
import type { ApplyResult } from "@/lib/server/kubernetes/api"
import { getKube, getKubeEnvironment, KubeError, NAMESPACE_COOKIE } from "@/lib/server/kubernetes"
import { fieldErrors, type ActionState } from "@/lib/validation"

// Every action names the environment the page was rendered for; getKube()
// refuses if the current one differs (switched in another tab), so nothing
// lands on the wrong cluster. Restarting a workload is an operator action
// (like restarting a container); everything else needs the manager role.

const envIdSchema = z.number().int().positive()
const objectSchema = z.object({
  environmentId: envIdSchema,
  namespace: namespaceSchema,
  name: objectNameSchema,
})
const workloadSchema = objectSchema.extend({ kind: z.enum(WORKLOAD_KINDS) })

type ObjectRef = z.infer<typeof objectSchema>
type WorkloadRef = ObjectRef & { kind: WorkloadKind }

/** Namespace for the list pages (null = all). Any user; only a preference cookie. */
export async function selectNamespace(environmentId: number, namespace: string | null): Promise<ActionState> {
  const { t } = await getI18n()
  const user = await getCurrentUser()
  if (!user) return { error: t.common.errors.sessionExpired }
  const parsed = z.object({ environmentId: envIdSchema, namespace: namespaceSchema.nullable() }).safeParse({ environmentId, namespace })
  if (!parsed.success) return { error: t.kubernetes.actions.invalidNamespace }
  try {
    await getKubeEnvironment(parsed.data.environmentId)
  } catch (err) {
    if (err instanceof KubeError) return { error: err.message }
    throw err
  }
  ;(await cookies()).set(NAMESPACE_COOKIE, `${parsed.data.environmentId}:${parsed.data.namespace ?? ""}`, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  })
  refresh()
  return { ok: true }
}

function parseRef<T>(schema: z.ZodType<T>, input: unknown): T | null {
  const parsed = schema.safeParse(input)
  return parsed.success ? parsed.data : null
}

const label = (ref: { namespace: string; name: string; kind?: string }) =>
  `${ref.kind ? `${ref.kind} ` : ""}${ref.namespace}/${ref.name}`

export async function scaleWorkload(ref: WorkloadRef, replicas: number): Promise<ActionState> {
  const { t, format } = await getI18n()
  const w = parseRef(workloadSchema, ref)
  if (!w) return { error: t.kubernetes.actions.invalidWorkload }
  if (w.kind === "DaemonSet") return { error: t.kubernetes.actions.daemonSetScale }
  const n = z.number().int().min(0).max(MAX_REPLICAS).safeParse(replicas)
  if (!n.success) return { error: format(t.kubernetes.actions.replicasRange, { max: MAX_REPLICAS }) }

  return runAction(inEnvironment("manage", w.environmentId), "kubernetes.scale", `${label(w)} → ${n.data}`, async () => {
    const { api } = await getKube(w.environmentId)
    await api.scaleWorkload(w.kind, w.namespace, w.name, n.data)
    return format(t.kubernetes.actions.scaled, { name: w.name, count: n.data })
  })
}

export async function restartWorkload(ref: WorkloadRef): Promise<ActionState> {
  const { t, format } = await getI18n()
  const w = parseRef(workloadSchema, ref)
  if (!w) return { error: t.kubernetes.actions.invalidWorkload }
  return runAction(inEnvironment("operate", w.environmentId), "kubernetes.restart", label(w), async () => {
    const { api } = await getKube(w.environmentId)
    await api.restartWorkload(w.kind, w.namespace, w.name)
    return format(t.kubernetes.actions.restarting, { name: w.name })
  })
}

export async function deleteWorkload(ref: WorkloadRef): Promise<ActionState> {
  const { t, format } = await getI18n()
  const w = parseRef(workloadSchema, ref)
  if (!w) return { error: t.kubernetes.actions.invalidWorkload }
  return runAction(inEnvironment("manage", w.environmentId), "kubernetes.delete", label(w), async () => {
    const { api } = await getKube(w.environmentId)
    await api.deleteWorkload(w.kind, w.namespace, w.name)
    return format(t.kubernetes.actions.workloadDeleted, { kind: w.kind, name: w.name })
  })
}

export async function deletePod(ref: ObjectRef): Promise<ActionState> {
  const { t, format } = await getI18n()
  const p = parseRef(objectSchema, ref)
  if (!p) return { error: t.kubernetes.actions.invalidPod }
  return runAction(inEnvironment("manage", p.environmentId), "kubernetes.delete", label({ ...p, kind: "Pod" }), async () => {
    const { api } = await getKube(p.environmentId)
    await api.deletePod(p.namespace, p.name)
    return format(t.kubernetes.actions.podDeleted, { name: p.name })
  })
}

/** FormDialog action: fields `environment` and `name`. */
export async function createNamespace(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ environment: z.coerce.number().int().positive(), name: namespaceSchema })
    .safeParse({ environment: formData.get("environment"), name: formData.get("name") ?? "" })
  if (!parsed.success) return fieldErrors(parsed.error)
  const { environment, name } = parsed.data
  const { t, format } = await getI18n()

  return runAction(inEnvironment("manage", environment), "kubernetes.namespace.create", name, async () => {
    const { api } = await getKube(environment)
    try {
      await api.createNamespace(name)
    } catch (err) {
      if (err instanceof KubeError && err.reason === "AlreadyExists") throw new UserError(format(t.kubernetes.actions.namespaceExists, { name }))
      throw err
    }
    return format(t.kubernetes.actions.namespaceCreated, { name })
  })
}

export async function deleteNamespace(environmentId: number, name: string): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = z.object({ environmentId: envIdSchema, name: namespaceSchema }).safeParse({ environmentId, name })
  if (!parsed.success) return { error: t.kubernetes.actions.invalidNamespace }
  if (PROTECTED_NAMESPACES.has(parsed.data.name)) {
    return { error: format(t.kubernetes.actions.namespaceProtected, { name: parsed.data.name }) }
  }

  return runAction(inEnvironment("manage", parsed.data.environmentId), "kubernetes.namespace.delete", parsed.data.name, async () => {
    const { api } = await getKube(parsed.data.environmentId)
    await api.deleteNamespace(parsed.data.name)
    return format(t.kubernetes.actions.namespaceDeleting, { name: parsed.data.name })
  })
}

export type ApplyState = ActionState & { results?: ApplyResult[] }

/**
 * Server-side apply of a multi-document manifest into a namespace. The
 * manifest is echoed back in `values` (it may contain Secrets, but only the
 * user who submitted it sees it); results carry no object content.
 */
export async function applyManifest(_prev: ApplyState, formData: FormData): Promise<ApplyState> {
  const { t, format } = await getI18n()
  const k = t.kubernetes.apply
  const parsed = z
    .object({
      environment: z.coerce.number().int().positive(),
      namespace: namespaceSchema,
      manifest: z.string().max(MAX_MANIFEST_BYTES * 2, k.tooLarge),
      force: z.enum(["on"]).optional(),
      dry_run: z.enum(["on"]).optional(),
    })
    .safeParse(Object.fromEntries([...formData].filter(([, v]) => typeof v === "string")))
  const values = {
    manifest: String(formData.get("manifest") ?? ""),
    namespace: String(formData.get("namespace") ?? ""),
    force: formData.get("force") === "on" ? "on" : "",
    dry_run: formData.get("dry_run") === "on" ? "on" : "",
  }
  if (!parsed.success) return { ...fieldErrors(parsed.error), values }
  const v = parsed.data

  const manifest = parseManifest(v.manifest)
  if (!manifest.ok) return { error: k.fixManifest, fieldErrors: { manifest: [manifest.error] }, values }

  let results: ApplyResult[] = []
  const summary = manifest.objects.map((o) => `${o.kind}/${o.name}`).join(", ")
  const res = await runAction(
    inEnvironment("manage", v.environment),
    v.dry_run ? "kubernetes.apply.dry-run" : "kubernetes.apply",
    `${v.namespace}: ${summary}`.slice(0, 250),
    async ({ user }) => {
      const { api } = await getKube(v.environment)
      results = await api.apply(manifest.objects, { namespace: v.namespace, force: Boolean(v.force), dryRun: Boolean(v.dry_run) })
      const failed = results.filter((r) => r.status === "error").length
      if (failed && !v.dry_run) await audit(user, "kubernetes.apply.failed", `${v.namespace}: ${failed} of ${results.length} object(s)`)
      const verb = v.dry_run ? k.verbDryRun : k.verbApplied
      return failed
        ? format(k.summaryPartial, { done: results.length - failed, total: results.length, verb, failed })
        : format(k.summary, { count: results.length, verb })
    }
  )
  // A partial failure is still reported with every object's outcome.
  return { ...res, results, values }
}
