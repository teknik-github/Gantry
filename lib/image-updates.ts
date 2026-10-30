// Pure helpers for image update checks: which references can be checked and
// whether a local image matches the digest a registry serves for its tag.

export type UpdateStatus = "update" | "current" | "unknown"

/** What the containers list shows per container (null: not checked yet). */
export type ContainerUpdate = {
  status: UpdateStatus
  /** The reference that was checked, e.g. "nginx:latest". */
  reference: string
  /** Why the status is unknown (registry error, local-only image, ...). */
  reason?: string
  /** Digest the registry served at the last check. */
  remoteDigest?: string
  checkedAt: number
}

const IMAGE_ID_RE = /^(sha256:)?[a-f0-9]{12,64}$/

/** Docker lists a container's image as its id once the tag it was created from moved on. */
export function isImageId(reference: string) {
  return IMAGE_ID_RE.test(reference.trim())
}

/**
 * The reference to ask the registry about, with an explicit tag; null for
 * references that can't change: image ids and digest-pinned ones.
 */
export function checkableReference(reference: string): string | null {
  const ref = reference.trim()
  if (!ref || IMAGE_ID_RE.test(ref) || ref.includes("@")) return null
  const lastSlash = ref.lastIndexOf("/")
  const lastColon = ref.lastIndexOf(":")
  return lastColon > lastSlash ? ref : `${ref}:latest`
}

/** Whether any of an image's RepoDigests ("repo@sha256:…") carries `digest`. */
export function hasDigest(repoDigests: readonly string[] | null | undefined, digest: string) {
  return (repoDigests ?? []).some((d) => d.slice(d.indexOf("@") + 1) === digest)
}

/** "nginx:1" and "docker.io/library/nginx:1" name the same tag (RepoTags use the short form). */
export function shortReference(reference: string) {
  return reference.replace(/^docker\.io\//, "").replace(/^library\//, "")
}

export type LocalImage = { Id: string; RepoTags?: readonly string[] | null; RepoDigests?: readonly string[] | null }

/**
 * Compares what a container runs with what the registry serves for its tag.
 *
 * - The tag already points at another local image (pulled, not recreated):
 *   update.
 * - Otherwise the image's RepoDigests, or its id (with the containerd image
 *   store the id *is* the pulled digest), match the registry: current.
 * - No digest to compare (built or loaded locally): unknown.
 */
export function containerUpdateStatus(
  imageId: string,
  local: { tagged: LocalImage | null; running: LocalImage | null },
  remote: { digest: string | null; error: string | null }
): { status: UpdateStatus; reason?: string } {
  if (remote.error || !remote.digest) return { status: "unknown", reason: remote.error ?? "No digest from the registry" }
  if (local.tagged && local.tagged.Id !== imageId) return { status: "update", reason: "A newer image for this tag is already pulled" }
  const image = local.tagged ?? local.running
  if (imageId === remote.digest || hasDigest(image?.RepoDigests, remote.digest)) return { status: "current" }
  if (!image?.RepoDigests?.length) return { status: "unknown", reason: "Built or loaded locally; not from a registry" }
  return { status: "update" }
}
