"use server"

import { cookies } from "next/headers"
import { refresh } from "next/cache"
import { z } from "zod"

import { MAX_MANIFEST_BYTES, parseManifest } from "@/lib/kubernetes/manifest"
import {
  MAX_REPLICAS,
  namespaceSchema,
  objectNameSchema,
  PROTECTED_NAMESPACES,
  WORKLOAD_KINDS,
  type WorkloadKind,
} from "@/lib/kubernetes/names"
import { runAction, UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import { getCurrentUser } from "@/lib/server/auth/dal"
import type { ApplyResult } from "@/lib/server/kubernetes/api"
import { getKube, getKubeEnvironment, KubeError, NAMESPACE_COOKIE } from "@/lib/server/kubernetes"
import { fieldErrors, type ActionState } from "@/lib/validation"

// Every action names the environment the page was rendered for; getKube()
// refuses if the current one differs (switched in another tab), so nothing
// lands on the wrong cluster.

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
  const user = await getCurrentUser()
  if (!user) return { error: "Your session has expired. Please sign in again." }
  const parsed = z.object({ environmentId: envIdSchema, namespace: namespaceSchema.nullable() }).safeParse({ environmentId, namespace })
  if (!parsed.success) return { error: "Invalid namespace" }
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
  const w = parseRef(workloadSchema, ref)
  if (!w) return { error: "Invalid workload" }
  if (w.kind === "DaemonSet") return { error: "DaemonSets run one pod per node and can't be scaled" }
  const n = z.number().int().min(0).max(MAX_REPLICAS).safeParse(replicas)
  if (!n.success) return { error: `Replicas must be a whole number from 0 to ${MAX_REPLICAS}` }

  return runAction("admin", "kubernetes.scale", `${label(w)} → ${n.data}`, async () => {
    const { api } = await getKube(w.environmentId)
    await api.scaleWorkload(w.kind, w.namespace, w.name, n.data)
    return `${w.name} scaled to ${n.data}`
  })
}

export async function restartWorkload(ref: WorkloadRef): Promise<ActionState> {
  const w = parseRef(workloadSchema, ref)
  if (!w) return { error: "Invalid workload" }
  return runAction("admin", "kubernetes.restart", label(w), async () => {
    const { api } = await getKube(w.environmentId)
    await api.restartWorkload(w.kind, w.namespace, w.name)
    return `Restarting ${w.name}`
  })
}

export async function deleteWorkload(ref: WorkloadRef): Promise<ActionState> {
  const w = parseRef(workloadSchema, ref)
  if (!w) return { error: "Invalid workload" }
  return runAction("admin", "kubernetes.delete", label(w), async () => {
    const { api } = await getKube(w.environmentId)
    await api.deleteWorkload(w.kind, w.namespace, w.name)
    return `${w.kind} ${w.name} deleted`
  })
}

export async function deletePod(ref: ObjectRef): Promise<ActionState> {
  const p = parseRef(objectSchema, ref)
  if (!p) return { error: "Invalid pod" }
  return runAction("admin", "kubernetes.delete", label({ ...p, kind: "Pod" }), async () => {
    const { api } = await getKube(p.environmentId)
    await api.deletePod(p.namespace, p.name)
    return `Pod ${p.name} deleted`
  })
}

/** FormDialog action: fields `environment` and `name`. */
export async function createNamespace(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({ environment: z.coerce.number().int().positive(), name: namespaceSchema })
    .safeParse({ environment: formData.get("environment"), name: formData.get("name") ?? "" })
  if (!parsed.success) return fieldErrors(parsed.error)
  const { environment, name } = parsed.data

  return runAction("admin", "kubernetes.namespace.create", name, async () => {
    const { api } = await getKube(environment)
    try {
      await api.createNamespace(name)
    } catch (err) {
      if (err instanceof KubeError && err.reason === "AlreadyExists") throw new UserError(`Namespace "${name}" already exists`)
      throw err
    }
    return `Namespace ${name} created`
  })
}

export async function deleteNamespace(environmentId: number, name: string): Promise<ActionState> {
  const parsed = z.object({ environmentId: envIdSchema, name: namespaceSchema }).safeParse({ environmentId, name })
  if (!parsed.success) return { error: "Invalid namespace" }
  if (PROTECTED_NAMESPACES.has(parsed.data.name)) return { error: `The ${parsed.data.name} namespace can't be deleted` }

  return runAction("admin", "kubernetes.namespace.delete", parsed.data.name, async () => {
    const { api } = await getKube(parsed.data.environmentId)
    await api.deleteNamespace(parsed.data.name)
    return `Deleting namespace ${parsed.data.name} and everything in it`
  })
}

export type ApplyState = ActionState & { results?: ApplyResult[] }

/**
 * Server-side apply of a multi-document manifest into a namespace. The
 * manifest is echoed back in `values` (it may contain Secrets, but only the
 * administrator who submitted it sees it); results carry no object content.
 */
export async function applyManifest(_prev: ApplyState, formData: FormData): Promise<ApplyState> {
  const parsed = z
    .object({
      environment: z.coerce.number().int().positive(),
      namespace: namespaceSchema,
      manifest: z.string().max(MAX_MANIFEST_BYTES * 2, "The manifest is too large"),
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
  if (!manifest.ok) return { error: "Please fix the manifest", fieldErrors: { manifest: [manifest.error] }, values }

  let results: ApplyResult[] = []
  const summary = manifest.objects.map((o) => `${o.kind}/${o.name}`).join(", ")
  const res = await runAction(
    "admin",
    v.dry_run ? "kubernetes.apply.dry-run" : "kubernetes.apply",
    `${v.namespace}: ${summary}`.slice(0, 250),
    async ({ user }) => {
      const { api } = await getKube(v.environment)
      results = await api.apply(manifest.objects, { namespace: v.namespace, force: Boolean(v.force), dryRun: Boolean(v.dry_run) })
      const failed = results.filter((r) => r.status === "error").length
      if (failed && !v.dry_run) await audit(user, "kubernetes.apply.failed", `${v.namespace}: ${failed} of ${results.length} object(s)`)
      const verb = v.dry_run ? "checked (dry run)" : "applied"
      return failed ? `${results.length - failed} of ${results.length} object(s) ${verb}; ${failed} failed` : `${results.length} object(s) ${verb}`
    }
  )
  // A partial failure is still reported with every object's outcome.
  return { ...res, results, values }
}
