import type { Metadata } from "next"
import Link from "next/link"
import { CuboidIcon, FolderTreeIcon, ServerIcon, TriangleAlertIcon } from "lucide-react"

import { KubeUnavailable, loadKubePage, NamespaceFilter } from "@/components/gantry/kubernetes/page"
import { NodesTable } from "@/components/gantry/kubernetes/tables"
import { PageBody, PageHeader } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { podsByPhase, toNodeRows } from "@/lib/kubernetes/rows"
import { KubeError } from "@/lib/server/kubernetes/client"

export const metadata: Metadata = { title: "Kubernetes" }

/** Settles a call: the value, or the API's message (e.g. forbidden by RBAC). */
async function settle<T>(promise: Promise<T>): Promise<{ data: T; error?: never } | { data?: never; error: string }> {
  try {
    return { data: await promise }
  } catch (err) {
    if (err instanceof KubeError) return { error: err.message }
    throw err
  }
}

export default async function KubernetesOverviewPage() {
  const { page, blocked } = await loadKubePage()
  if (!page) {
    return (
      <PageBody>
        <PageHeader title="Kubernetes" />
        {blocked}
      </PageBody>
    )
  }
  const { api, env, namespace } = page

  // Each part on its own: a namespaced service account may not list nodes.
  const [version, nodes, namespaces, pods, warnings] = await Promise.all([
    settle(api.version()),
    settle(api.listNodes()),
    settle(api.listNamespaces()),
    settle(api.listPods(namespace)),
    settle(api.listEvents(namespace, "Warning")),
  ])

  const header = (
    <PageHeader
      title={`Cluster: ${env.name}`}
      description={version.data ? `Kubernetes ${version.data.gitVersion} · ${env.url}` : env.url}
      actions={<NamespaceFilter page={page} />}
    />
  )

  // Nothing at all: the cluster is unreachable or the credentials are rejected.
  if (version.error !== undefined && pods.error !== undefined) {
    return (
      <PageBody>
        {header}
        <KubeUnavailable message={pods.error} />
      </PageBody>
    )
  }

  const nodeRows = nodes.data ? toNodeRows(nodes.data) : []
  const phases = pods.data ? podsByPhase(pods.data) : null
  const scope = namespace ? `in ${namespace}` : "in all namespaces"

  return (
    <PageBody>
      {header}
      <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 dark:*:data-[slot=card]:bg-card">
        <Card className="@container/card" data-testid="card-nodes">
          <CardHeader>
            <CardDescription>Nodes ready</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {nodes.data ? `${nodeRows.filter((n) => n.ready).length}/${nodeRows.length}` : "—"}
            </CardTitle>
            <CardAction>
              <ServerIcon className="size-4 text-muted-foreground" />
            </CardAction>
          </CardHeader>
          <CardFooter className="text-sm text-muted-foreground">
            {nodes.error ?? (version.data ? `Kubernetes ${version.data.gitVersion}` : "")}
          </CardFooter>
        </Card>
        <Card className="@container/card" data-testid="card-pods">
          <CardHeader>
            <CardDescription>Pods {scope}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {pods.data ? pods.data.length : "—"}
            </CardTitle>
            <CardAction>
              {phases ? (
                <Badge variant="outline">
                  <span className="size-2 rounded-full bg-emerald-500" />
                  {phases.Running} running
                </Badge>
              ) : null}
            </CardAction>
          </CardHeader>
          <CardFooter className="flex-col items-start gap-1.5 text-sm">
            <Link href="/kubernetes/pods" className="flex gap-2 font-medium hover:underline">
              Pods <CuboidIcon className="size-4" />
            </Link>
            <div className="text-muted-foreground">
              {phases
                ? `${phases.Pending} pending, ${phases.Succeeded} succeeded, ${phases.Failed} failed${phases.Unknown ? `, ${phases.Unknown} unknown` : ""}`
                : pods.error}
            </div>
          </CardFooter>
        </Card>
        <Card className="@container/card" data-testid="card-namespaces">
          <CardHeader>
            <CardDescription>Namespaces</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {namespaces.data ? namespaces.data.length : "—"}
            </CardTitle>
          </CardHeader>
          <CardFooter className="flex-col items-start gap-1.5 text-sm">
            <Link href="/kubernetes/namespaces" className="flex gap-2 font-medium hover:underline">
              Namespaces <FolderTreeIcon className="size-4" />
            </Link>
            {namespaces.error ? <div className="text-muted-foreground">{namespaces.error}</div> : null}
          </CardFooter>
        </Card>
        <Card className="@container/card" data-testid="card-warnings">
          <CardHeader>
            <CardDescription>Warning events {scope}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">
              {warnings.data ? warnings.data.length : "—"}
            </CardTitle>
          </CardHeader>
          <CardFooter className="flex-col items-start gap-1.5 text-sm">
            <Link href="/kubernetes/events" className="flex gap-2 font-medium hover:underline">
              Events <TriangleAlertIcon className="size-4" />
            </Link>
            {warnings.error ? <div className="text-muted-foreground">{warnings.error}</div> : null}
          </CardFooter>
        </Card>
      </div>
      <PageHeader title="Nodes" />
      {nodes.error !== undefined ? <KubeUnavailable message={nodes.error} /> : <NodesTable data={nodeRows} />}
    </PageBody>
  )
}
