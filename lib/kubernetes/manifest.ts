import { isMap, isScalar, isSeq, parseAllDocuments } from "yaml"

// Splitting and checking multi-document YAML manifests for "Apply manifest".
// Pure: shared by the Server Action and unit tests. The cluster does the
// real schema validation when the objects are applied.

export const MAX_MANIFEST_BYTES = 512 * 1024
export const MAX_MANIFEST_OBJECTS = 100

export type ManifestObject = {
  /** 1-based position in the manifest (Lists count their items separately). */
  index: number
  apiVersion: string
  kind: string
  name: string
  /** metadata.namespace from the manifest, if any. */
  namespace: string | null
  object: Record<string, unknown>
}

export type ManifestCheck = { ok: true; objects: ManifestObject[] } | { ok: false; error: string }

function firstLine(message: string) {
  return message.split("\n")[0]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

/**
 * Parses `---`-separated YAML documents into Kubernetes objects. Empty
 * documents are skipped, `kind: List` is expanded. Every object needs
 * apiVersion, kind and metadata.name (server-side apply can't generate names).
 */
export function parseManifest(text: string): ManifestCheck {
  if (!text.trim()) return { ok: false, error: "The manifest is empty" }
  if (new TextEncoder().encode(text).length > MAX_MANIFEST_BYTES) {
    return { ok: false, error: `The manifest is larger than ${MAX_MANIFEST_BYTES / 1024} KB` }
  }

  const docs = parseAllDocuments(text, { uniqueKeys: true })
  if (!Array.isArray(docs)) return { ok: false, error: "Invalid YAML" }

  const raw: { doc: number; value: unknown }[] = []
  for (const [i, doc] of docs.entries()) {
    if (doc.errors.length) return { ok: false, error: `Document ${i + 1}: invalid YAML: ${firstLine(doc.errors[0].message)}` }
    // Empty documents (nothing, or only comments) parse as null.
    if (doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)) continue
    if (!isMap(doc.contents) && !isSeq(doc.contents)) {
      return { ok: false, error: `Document ${i + 1} must be a mapping (apiVersion, kind, metadata, ...)` }
    }
    const value = doc.toJS({ maxAliasCount: 50 }) as unknown
    if (isRecord(value) && value.kind === "List" && Array.isArray(value.items)) {
      for (const item of value.items) raw.push({ doc: i + 1, value: item })
    } else {
      raw.push({ doc: i + 1, value })
    }
  }

  if (raw.length === 0) return { ok: false, error: "The manifest contains no objects" }
  if (raw.length > MAX_MANIFEST_OBJECTS) {
    return { ok: false, error: `At most ${MAX_MANIFEST_OBJECTS} objects can be applied at once` }
  }

  const objects: ManifestObject[] = []
  for (const [i, { doc, value }] of raw.entries()) {
    const where = `Document ${doc}`
    if (!isRecord(value)) return { ok: false, error: `${where} must be a mapping (apiVersion, kind, metadata, ...)` }
    const { apiVersion, kind, metadata } = value
    if (typeof apiVersion !== "string" || !/^([a-z0-9.-]+\/)?v[0-9a-z]+$/.test(apiVersion)) {
      return { ok: false, error: `${where}: missing or invalid apiVersion` }
    }
    if (typeof kind !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(kind)) {
      return { ok: false, error: `${where}: missing or invalid kind` }
    }
    if (!isRecord(metadata) || typeof metadata.name !== "string" || !metadata.name) {
      return { ok: false, error: `${where} (${kind}): metadata.name is required` }
    }
    if (metadata.namespace !== undefined && typeof metadata.namespace !== "string") {
      return { ok: false, error: `${where} (${kind} ${metadata.name}): metadata.namespace must be a string` }
    }
    objects.push({
      index: i + 1,
      apiVersion,
      kind,
      name: metadata.name,
      namespace: (metadata.namespace as string | undefined) || null,
      object: value,
    })
  }
  return { ok: true, objects }
}
