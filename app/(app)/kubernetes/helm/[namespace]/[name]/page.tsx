import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { HelmReleaseActions } from "@/components/gantry/kubernetes/helm"
import { HelmRollbackForm, HelmUpgradeForm } from "@/components/gantry/kubernetes/helm-forms"
import { KubeUnavailable, loadKubePage } from "@/components/gantry/kubernetes/page"
import { Age, KubeStatus } from "@/components/gantry/kubernetes/tables"
import { PageBody } from "@/components/gantry/page-body"
import { Mono, PageHeader } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { namespaceSchema, objectNameSchema } from "@/lib/kubernetes/names"
import { tryKube } from "@/lib/server/kubernetes"
import { getRelease, type HelmRevisionRow } from "@/lib/server/kubernetes/helm"
import { helmVersion, HELM_MISSING } from "@/lib/server/kubernetes/helm-cli"
import { listHelmRepos } from "@/lib/server/kubernetes/helm-repos"

export async function generateMetadata({ params }: PageProps<"/kubernetes/helm/[namespace]/[name]">): Promise<Metadata> {
  const { name } = await params
  return { title: `Helm release ${decodeURIComponent(name)}` }
}

function Block({ title, description, text, testId }: { title: string; description?: string; text: string; testId: string }) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <pre
          data-testid={testId}
          className="max-h-[60vh] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
        >
          {text}
        </pre>
      </CardContent>
    </Card>
  )
}

function History({ rows, current }: { rows: HelmRevisionRow[]; current: number }) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>History</CardTitle>
        <CardDescription>Revisions of this release (helm history).</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-lg border" data-testid="helm-history">
          <Table>
            <TableHeader className="bg-muted">
              <TableRow>
                <TableHead>Revision</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Chart</TableHead>
                <TableHead>App version</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((h) => (
                <TableRow key={h.revision}>
                  <TableCell className="tabular-nums">
                    {h.revision}
                    {h.revision === current ? " (current)" : ""}
                  </TableCell>
                  <TableCell>
                    <KubeStatus status={h.status} />
                  </TableCell>
                  <TableCell>
                    <Mono>
                      {h.chart}-{h.chartVersion}
                    </Mono>
                  </TableCell>
                  <TableCell>
                    <Mono>{h.appVersion || "—"}</Mono>
                  </TableCell>
                  <TableCell>
                    <Age at={h.updated} />
                  </TableCell>
                  <TableCell className="max-w-96 truncate text-muted-foreground" title={h.description}>
                    {h.description}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  )
}

export default async function HelmReleasePage({ params }: PageProps<"/kubernetes/helm/[namespace]/[name]">) {
  const { namespace: rawNs, name: rawName } = await params
  const namespace = decodeURIComponent(rawNs)
  const name = decodeURIComponent(rawName)
  const back = (
    <Button variant="outline" size="sm" asChild>
      <Link href="/kubernetes/helm">
        <ArrowLeftIcon data-icon="inline-start" />
        Helm releases
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
        <PageHeader title="Helm release" actions={back} />
        <KubeUnavailable message="Invalid release name" />
      </PageBody>
    )
  }

  const result = await tryKube(() => getRelease(page.api, namespace, name))
  if (result.error !== undefined || !result.data) {
    return (
      <PageBody>
        <PageHeader title={name} description={`Helm release in ${namespace}`} actions={back} />
        <KubeUnavailable message={result.error ?? `Helm release ${name} not found in ${namespace}`} />
      </PageBody>
    )
  }

  const r = result.data
  const isAdmin = page.user.role === "admin"
  const canManage = page.can.manage
  const [helm, repos] = canManage ? await Promise.all([helmVersion(), listHelmRepos()]) : [null, []]
  return (
    <PageBody>
      <PageHeader
        title={name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            Helm release in {namespace} · <KubeStatus status={r.status} />
            <Mono>
              {r.chart}-{r.chartVersion}
            </Mono>
            {r.appVersion ? <span>app {r.appVersion}</span> : null}
            <span>
              revision {r.revision}, updated <Age at={r.updated} />
            </span>
          </span>
        }
        actions={
          <>
            {back}
            {canManage ? <HelmReleaseActions environmentId={page.env.id} namespace={namespace} name={name} /> : null}
          </>
        }
      />
      {r.description ? <p className="px-4 text-sm text-muted-foreground lg:px-6">{r.description}</p> : null}
      <div className="px-4 lg:px-6">
        <History rows={r.history} current={r.revision} />
      </div>
      {canManage && !helm ? <KubeUnavailable message={`${HELM_MISSING} Upgrade and rollback are unavailable.`} /> : null}
      {canManage && helm ? (
        <div className="grid gap-4 px-4 lg:px-6 @5xl/main:grid-cols-2">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>Upgrade</CardTitle>
              <CardDescription>
                helm upgrade to another chart version and/or new values. Pick where the chart comes from.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <HelmUpgradeForm
                environmentId={page.env.id}
                namespace={namespace}
                release={name}
                chart={r.chart}
                repos={repos.map((repo) => ({ id: repo.id, name: repo.name, url: repo.url, oci: repo.oci }))}
                currentValues={isAdmin ? r.values : null}
              />
            </CardContent>
          </Card>
          <Card className="min-w-0 self-start">
            <CardHeader>
              <CardTitle>Roll back</CardTitle>
              <CardDescription>helm rollback to an earlier revision.</CardDescription>
            </CardHeader>
            <CardContent>
              <HelmRollbackForm
                environmentId={page.env.id}
                namespace={namespace}
                release={name}
                revisions={r.history
                  .filter((h) => h.revision !== r.revision)
                  .map((h) => ({ revision: h.revision, label: `${h.revision}: ${h.chart}-${h.chartVersion} (${h.status})` }))}
              />
            </CardContent>
          </Card>
        </div>
      ) : null}
      {isAdmin ? (
        <div className="grid gap-4 px-4 lg:px-6 @5xl/main:grid-cols-2">
          <Block
            title="Values"
            description="User-supplied values (helm get values). They may contain secrets."
            text={r.values || "# No values were set; the chart's defaults are used."}
            testId="helm-values"
          />
          <Block title="Manifest" description="What the release created (helm get manifest)." text={r.manifest} testId="helm-manifest" />
          {r.notes ? <Block title="Notes" text={r.notes} testId="helm-notes" /> : null}
        </div>
      ) : (
        <p className="px-4 text-sm text-muted-foreground lg:px-6">
          Values and manifests can contain secrets and are shown to administrators only.
        </p>
      )}
    </PageBody>
  )
}
