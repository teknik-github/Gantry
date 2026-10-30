import "server-only"

import { cookies } from "next/headers"

import { DOCKER_ENVIRONMENT, NO_ENVIRONMENT_ASSIGNED } from "@/lib/messages"
import { getCurrentUser } from "@/lib/server/auth/dal"
import type { Environment } from "@/lib/server/db/schema"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { kube, type KubeApi } from "@/lib/server/kubernetes/api"
import { KubeError } from "@/lib/server/kubernetes/client"
import { kubeTarget } from "@/lib/server/kubernetes/target"

export { KubeError } from "@/lib/server/kubernetes/client"

/** Remembers the namespace picked on the list pages: "<environment id>:<namespace>", empty = all. */
export const NAMESPACE_COOKIE = "gantry_k8s_ns"

/**
 * The current environment if it is a Kubernetes cluster the user may use.
 * Pass the id the page was rendered for so an action never lands on another
 * cluster after the environment was switched in a different tab.
 */
export async function getKubeEnvironment(expectedId?: number): Promise<Environment> {
  const env = await getCurrentEnvironment()
  if (!env) {
    const user = await getCurrentUser()
    throw new KubeError(user?.role === "admin" ? "No environment configured" : NO_ENVIRONMENT_ASSIGNED, 403)
  }
  if (env.type !== "kubernetes") throw new KubeError(DOCKER_ENVIRONMENT, 409)
  if (expectedId !== undefined && env.id !== expectedId) {
    throw new KubeError("The environment was switched in the meantime. Reload the page and try again.", 409)
  }
  return env
}

/** Kubernetes client for the current environment. Callers must authenticate first. */
export async function getKube(expectedId?: number): Promise<{ env: Environment; api: KubeApi }> {
  const env = await getKubeEnvironment(expectedId)
  return { env, api: kube(kubeTarget(env)) }
}

/**
 * Namespace the list pages show: the one picked with the selector, else the
 * environment's default namespace, else all (null).
 */
export async function selectedNamespace(env: Pick<Environment, "id" | "kube_namespace">): Promise<string | null> {
  const raw = (await cookies()).get(NAMESPACE_COOKIE)?.value
  if (raw) {
    const sep = raw.indexOf(":")
    if (Number(raw.slice(0, sep)) === env.id) return raw.slice(sep + 1) || null
  }
  return env.kube_namespace ?? null
}

/** Runs Kubernetes calls and turns API failures into a renderable error. */
export async function tryKube<T>(fn: () => Promise<T>): Promise<{ data: T; error?: never } | { data?: never; error: string }> {
  try {
    return { data: await fn() }
  } catch (err) {
    if (err instanceof KubeError) return { error: err.message }
    throw err
  }
}
