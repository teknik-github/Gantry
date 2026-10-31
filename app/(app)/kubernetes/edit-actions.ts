"use server"

import { z } from "zod"

import { diffText, type DiffResult } from "@/lib/kubernetes/diff"
import { editableObject, editableResource, parseEditedObject, toYaml, updateBody } from "@/lib/kubernetes/edit"
import { namespaceSchema, objectNameSchema } from "@/lib/kubernetes/names"
import { authorize, inEnvironment, runAction, UserError } from "@/lib/server/action"
import { getKube, KubeError } from "@/lib/server/kubernetes"

// "Edit YAML": review (server-side dry run of the update, diffed against
// the live object) and apply (the same update for real). Both send the
// resourceVersion the editor was loaded at, so a change made by someone
// else in between is reported as a conflict instead of being overwritten.
// Editing needs the manager role; Secrets (their data is in the YAML)
// need an administrator, as everywhere else in Gantry.

export type EditInput = {
  environmentId: number
  resource: string
  namespace: string
  name: string
  resourceVersion: string
  yaml: string
}

export type EditResult = {
  ok?: boolean
  error?: string
  message?: string
  /** The object changed on the server since it was loaded. */
  conflict?: boolean
  diff?: DiffResult
  /** Review: whether the update would change anything. */
  unchanged?: boolean
  /** Apply: the version that is now live. */
  resourceVersion?: string
}

const inputSchema = z.object({
  environmentId: z.number().int().positive(),
  resource: z.string().max(64),
  namespace: namespaceSchema,
  name: objectNameSchema,
  resourceVersion: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
  yaml: z.string(),
})

const CONFLICT_MESSAGE =
  "Someone changed this object since you opened it, so your edit was not applied. Load the latest version and make your change again."

/** Validates the input; returns the resource and the request body, or an error to show. */
function prepare(input: EditInput) {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) return { error: "Invalid request" } as const
  const v = parsed.data
  const resource = editableResource(v.resource)
  if (!resource) return { error: "This kind of object can't be edited here" } as const
  const edited = parseEditedObject(v.yaml, { apiVersion: resource.apiVersion, kind: resource.kind, namespace: v.namespace, name: v.name })
  if (!edited.ok) return { error: edited.error } as const
  return { v, resource, body: updateBody(edited.object, v.namespace, v.resourceVersion) } as const
}

function isConflict(err: unknown) {
  return err instanceof KubeError && err.status === 409
}

/** Dry-run of the update and the diff it would make. Changes nothing (not audited). */
export async function reviewKubeEdit(input: EditInput): Promise<EditResult> {
  const p = prepare(input)
  if ("error" in p) return { error: p.error }
  const { v, resource, body } = p
  const auth = await authorize(inEnvironment("manage", v.environmentId))
  if ("error" in auth) return { error: auth.error }
  if (resource.adminOnly && auth.user.role !== "admin") return { error: "Only administrators can edit Secrets." }

  try {
    const { api } = await getKube(v.environmentId)
    const [current, result] = await Promise.all([
      api.getObject(resource.apiVersion, resource.resource, v.namespace, v.name),
      api.replaceObject(resource.apiVersion, resource.resource, v.namespace, v.name, body, true),
    ])
    const currentVersion = (current.metadata as { resourceVersion?: string } | undefined)?.resourceVersion
    if (currentVersion && currentVersion !== v.resourceVersion) return { error: CONFLICT_MESSAGE, conflict: true }
    const diff = diffText(toYaml(editableObject(current)), toYaml(editableObject(result)))
    return { ok: true, diff, unchanged: diff.hunks.length === 0 }
  } catch (err) {
    if (isConflict(err)) return { error: CONFLICT_MESSAGE, conflict: true }
    if (err instanceof KubeError) return { error: err.message }
    console.error("[gantry] kubernetes edit review failed", err)
    return { error: "Something went wrong. Check the server logs." }
  }
}

/** Applies the edit (conditional update). */
export async function applyKubeEdit(input: EditInput): Promise<EditResult> {
  const p = prepare(input)
  if ("error" in p) return { error: p.error }
  const { v, resource, body } = p
  let conflict = false
  let resourceVersion: string | undefined
  const res = await runAction(
    inEnvironment("manage", v.environmentId),
    "kubernetes.edit",
    `${resource.kind} ${v.namespace}/${v.name}`,
    async ({ user }) => {
      if (resource.adminOnly && user.role !== "admin") throw new UserError("Only administrators can edit Secrets.")
      const { api } = await getKube(v.environmentId)
      try {
        const updated = await api.replaceObject(resource.apiVersion, resource.resource, v.namespace, v.name, body, false)
        resourceVersion = (updated.metadata as { resourceVersion?: string } | undefined)?.resourceVersion
      } catch (err) {
        if (isConflict(err)) {
          conflict = true
          throw new UserError(CONFLICT_MESSAGE)
        }
        throw err
      }
      return `${resource.kind} ${v.name} updated`
    }
  )
  return { ...res, conflict: conflict || undefined, resourceVersion }
}
