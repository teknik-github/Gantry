import { isMap, parseAllDocuments, stringify } from "yaml"

// "Edit YAML" for single objects: which kinds can be edited, what of the
// live object is shown, and checks on what comes back from the editor.
// Shared by the Server Actions and the page; no Node APIs.

export type EditableResource = {
  kind: string
  apiVersion: string
  /** Plural resource name, also the URL segment (/kubernetes/edit/<resource>/<ns>/<name>). */
  resource: string
  /** Secret data is shown to administrators only. */
  adminOnly?: boolean
}

export const EDITABLE_RESOURCES = {
  deployments: { kind: "Deployment", apiVersion: "apps/v1", resource: "deployments" },
  statefulsets: { kind: "StatefulSet", apiVersion: "apps/v1", resource: "statefulsets" },
  daemonsets: { kind: "DaemonSet", apiVersion: "apps/v1", resource: "daemonsets" },
  services: { kind: "Service", apiVersion: "v1", resource: "services" },
  ingresses: { kind: "Ingress", apiVersion: "networking.k8s.io/v1", resource: "ingresses" },
  configmaps: { kind: "ConfigMap", apiVersion: "v1", resource: "configmaps" },
  secrets: { kind: "Secret", apiVersion: "v1", resource: "secrets", adminOnly: true },
} as const satisfies Record<string, EditableResource>

export type EditableResourceName = keyof typeof EDITABLE_RESOURCES

export function editableResource(name: string): EditableResource | null {
  return Object.hasOwn(EDITABLE_RESOURCES, name) ? EDITABLE_RESOURCES[name as EditableResourceName] : null
}

export function resourceForKind(kind: string): EditableResourceName | null {
  const entry = Object.entries(EDITABLE_RESOURCES).find(([, r]) => r.kind === kind)
  return entry ? (entry[0] as EditableResourceName) : null
}

/** Link to the editor of an object. */
export function editHref(kind: string, namespace: string, name: string): string | null {
  const resource = resourceForKind(kind)
  return resource ? `/kubernetes/edit/${resource}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}` : null
}

/** Objects larger than this (as YAML) are not edited here. */
export const MAX_EDIT_BYTES = 512 * 1024

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v)

/**
 * The object as shown in the editor: no status, no managedFields and none
 * of the server-maintained metadata (the resourceVersion travels next to
 * the text, so it can't be edited away by accident).
 */
export function editableObject(live: Obj): Obj {
  const out: Obj = {}
  for (const [k, v] of Object.entries(live)) if (k !== "status") out[k] = v
  if (isObj(live.metadata)) {
    const meta: Obj = {}
    for (const [k, v] of Object.entries(live.metadata)) {
      if (["managedFields", "resourceVersion", "uid", "generation", "creationTimestamp", "selfLink"].includes(k)) continue
      meta[k] = v
    }
    out.metadata = meta
  }
  return out
}

/** YAML for the editor and the diff: block style, no line folding. */
export function toYaml(obj: unknown): string {
  return stringify(obj, { lineWidth: 0, minContentWidth: 0 })
}

export type ParsedEdit = { ok: true; object: Obj } | { ok: false; error: string }

/**
 * Parses the editor text and checks it still describes the object being
 * edited: one YAML mapping with the same apiVersion, kind, name and
 * namespace (renaming or moving would create another object).
 */
export function parseEditedObject(
  text: string,
  expected: { apiVersion: string; kind: string; namespace: string; name: string }
): ParsedEdit {
  if (!text.trim()) return { ok: false, error: "The YAML is empty" }
  if (new TextEncoder().encode(text).length > MAX_EDIT_BYTES) return { ok: false, error: "The YAML is too large" }
  const docs = parseAllDocuments(text, { uniqueKeys: true })
  if (!Array.isArray(docs)) return { ok: false, error: "Invalid YAML" }
  const nonEmpty = docs.filter((d) => d.contents !== null || d.errors.length)
  if (nonEmpty.length !== 1) return { ok: false, error: "Edit exactly one object (no --- separators)" }
  const doc = nonEmpty[0]
  if (doc.errors.length) {
    const e = doc.errors[0]
    const line = e.linePos?.[0]?.line
    return { ok: false, error: `Invalid YAML${line ? ` (line ${line})` : ""}: ${e.message.split("\n")[0]}` }
  }
  if (!isMap(doc.contents)) return { ok: false, error: "The YAML must be a mapping (an object)" }
  let object: unknown
  try {
    object = doc.toJS({ maxAliasCount: 50 })
  } catch (err) {
    return { ok: false, error: `Invalid YAML: ${(err as Error).message}` }
  }
  if (!isObj(object)) return { ok: false, error: "The YAML must be a mapping (an object)" }
  if (object.apiVersion !== expected.apiVersion) {
    return { ok: false, error: `apiVersion must stay ${expected.apiVersion}` }
  }
  if (object.kind !== expected.kind) return { ok: false, error: `kind must stay ${expected.kind}` }
  if (!isObj(object.metadata)) return { ok: false, error: "metadata is missing" }
  if (object.metadata.name !== expected.name) {
    return { ok: false, error: `metadata.name must stay ${expected.name} (renaming would create another object)` }
  }
  const ns = object.metadata.namespace
  if (ns !== undefined && ns !== expected.namespace) {
    return { ok: false, error: `metadata.namespace must stay ${expected.namespace}` }
  }
  return { ok: true, object }
}

/**
 * The body for the update (PUT): the edited object with the namespace and
 * the resourceVersion it was loaded at, so a change made by someone else
 * in the meantime fails with 409 Conflict instead of being overwritten.
 */
export function updateBody(object: Obj, namespace: string, resourceVersion: string): Obj {
  const metadata: Obj = { ...(object.metadata as Obj), namespace, resourceVersion }
  delete metadata.managedFields
  return { ...object, metadata }
}
