import "server-only"

import { CircleAlertIcon } from "lucide-react"

import { NamespaceSelect } from "@/components/gantry/kubernetes/namespace-select"
import { NoEnvironment, WrongEnvironmentKind } from "@/components/gantry/ui"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireUser, type CurrentUser } from "@/lib/server/auth/dal"
import type { Environment } from "@/lib/server/db/schema"
import type { Permissions } from "@/lib/permissions"
import { getCurrentEnvironment, getPermissions } from "@/lib/server/environments"
import { selectedNamespace } from "@/lib/server/kubernetes"
import { kube, type KubeApi } from "@/lib/server/kubernetes/api"
import { KubeError } from "@/lib/server/kubernetes/client"
import { kubeTarget } from "@/lib/server/kubernetes/target"

export type KubePage = {
  user: CurrentUser
  /** What the user may do in this cluster (lib/permissions.ts). */
  can: Permissions
  env: Environment
  api: KubeApi
  /** Selected namespace, null = all. */
  namespace: string | null
}

/**
 * Common start of every Kubernetes page: the signed-in user, the current
 * environment (must be a cluster they may use) and the selected namespace.
 * Returns `blocked` with an empty state to render instead otherwise.
 */
export async function loadKubePage(): Promise<{ page: KubePage; blocked?: never } | { page?: never; blocked: React.ReactNode }> {
  const user = await requireUser()
  const env = await getCurrentEnvironment()
  if (!env) {
    return {
      blocked: user.role === "admin" ? <KubeUnavailable message="No environment configured. Add one on the Environments page." /> : <NoEnvironment />,
    }
  }
  if (env.type !== "kubernetes") return { blocked: <WrongEnvironmentKind kind="docker" /> }
  try {
    return { page: { user, can: await getPermissions(), env, api: kube(kubeTarget(env)), namespace: await selectedNamespace(env) } }
  } catch (err) {
    if (err instanceof KubeError) return { blocked: <KubeUnavailable message={err.message} /> }
    throw err
  }
}

/** The namespace selector for a page header. Namespaces that can't be listed (RBAC) leave just the current choice. */
export async function NamespaceFilter({ page }: { page: KubePage }) {
  const namespaces = await page.api.listNamespaces().then(
    (list) => list.map((n) => n.metadata.name).sort(),
    () => (page.env.kube_namespace ? [page.env.kube_namespace] : [])
  )
  return <NamespaceSelect environmentId={page.env.id} namespaces={namespaces} selected={page.namespace} />
}

export function KubeUnavailable({ message }: { message: string }) {
  return (
    <div className="px-4 lg:px-6">
      <Card className="border-destructive/40" data-testid="kube-error">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <CircleAlertIcon className="size-4" />
            Kubernetes API error
          </CardTitle>
          <CardDescription className="break-words">{message}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  )
}
