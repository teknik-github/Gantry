import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { PodActions } from "@/components/gantry/kubernetes/pod-actions"
import { PodLogViewer } from "@/components/gantry/kubernetes/pod-logs"
import { KubeUnavailable, loadKubePage } from "@/components/gantry/kubernetes/page"
import { Age, KubeStatus } from "@/components/gantry/kubernetes/tables"
import { PageBody } from "@/components/gantry/page-body"
import { Mono, PageHeader } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { namespaceSchema, objectNameSchema } from "@/lib/kubernetes/names"
import { podStatus } from "@/lib/kubernetes/rows"
import type { ContainerState } from "@/lib/server/kubernetes/api"
import { tryKube } from "@/lib/server/kubernetes"

export async function generateMetadata({ params }: PageProps<"/kubernetes/pods/[namespace]/[name]">): Promise<Metadata> {
  const { name } = await params
  return { title: `Pod ${decodeURIComponent(name)}` }
}

function stateLabel(state?: ContainerState) {
  if (state?.running) return "Running"
  if (state?.waiting) return state.waiting.reason ?? "Waiting"
  if (state?.terminated) return state.terminated.reason ?? `Exited (${state.terminated.exitCode ?? "?"})`
  return "Unknown"
}

export default async function PodPage({ params }: PageProps<"/kubernetes/pods/[namespace]/[name]">) {
  const { namespace: rawNs, name: rawName } = await params
  const namespace = decodeURIComponent(rawNs)
  const name = decodeURIComponent(rawName)
  const back = (
    <Button variant="outline" size="sm" asChild>
      <Link href="/kubernetes/pods">
        <ArrowLeftIcon data-icon="inline-start" />
        Pods
      </Link>
    </Button>
  )

  const { page, blocked } = await loadKubePage()
  if (!page) {
    return (
      <PageBody>
        <PageHeader title={name} actions={back} />
        {blocked}
      </PageBody>
    )
  }
  if (!namespaceSchema.safeParse(namespace).success || !objectNameSchema.safeParse(name).success) {
    return (
      <PageBody>
        <PageHeader title="Pod" actions={back} />
        <KubeUnavailable message="Invalid pod name" />
      </PageBody>
    )
  }

  const result = await tryKube(() => page.api.getPod(namespace, name))
  if (result.error !== undefined) {
    return (
      <PageBody>
        <PageHeader title={name} description={`Pod in ${namespace}`} actions={back} />
        <KubeUnavailable message={result.error} />
      </PageBody>
    )
  }

  const pod = result.data
  const statuses = new Map((pod.status?.containerStatuses ?? []).map((c) => [c.name, c]))
  const containers = (pod.spec?.containers ?? []).map((c) => ({ ...c, status: statuses.get(c.name) }))

  return (
    <PageBody>
      <PageHeader
        title={name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            Pod in {namespace} · <KubeStatus status={podStatus(pod)} />
            {pod.spec?.nodeName ? <span>on {pod.spec.nodeName}</span> : null}
            {pod.status?.podIP ? <Mono>{pod.status.podIP}</Mono> : null}
            <span>
              created <Age at={pod.metadata.creationTimestamp ?? ""} />
            </span>
          </span>
        }
        actions={
          <>
            {back}
            {page.can.manage ? <PodActions environmentId={page.env.id} namespace={namespace} name={name} /> : null}
          </>
        }
      />
      <div className="px-4 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>Containers</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Ready</TableHead>
                  <TableHead>Restarts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {containers.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>
                      <Mono>{c.image}</Mono>
                    </TableCell>
                    <TableCell>
                      <KubeStatus status={stateLabel(c.status?.state)} />
                    </TableCell>
                    <TableCell>{c.status?.ready ? "yes" : "no"}</TableCell>
                    <TableCell className="tabular-nums">{c.status?.restartCount ?? 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
      <div className="px-4 lg:px-6">
        {page.can.operate ? (
          <PodLogViewer
            environmentId={page.env.id}
            namespace={namespace}
            name={name}
            containers={containers.map((c) => c.name)}
          />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="logs-hidden">
            Logs need the operator role in this environment.
          </p>
        )}
      </div>
    </PageBody>
  )
}
