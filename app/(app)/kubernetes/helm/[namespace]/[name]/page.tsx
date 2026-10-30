import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { HelmReleaseActions } from "@/components/gantry/kubernetes/helm"
import { KubeUnavailable, loadKubePage } from "@/components/gantry/kubernetes/page"
import { Age, KubeStatus } from "@/components/gantry/kubernetes/tables"
import { PageBody } from "@/components/gantry/page-body"
import { Mono, PageHeader } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { namespaceSchema, objectNameSchema } from "@/lib/kubernetes/names"
import { tryKube } from "@/lib/server/kubernetes"
import { getRelease } from "@/lib/server/kubernetes/helm"

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
            {isAdmin ? <HelmReleaseActions environmentId={page.env.id} namespace={namespace} name={name} /> : null}
          </>
        }
      />
      {r.description ? <p className="px-4 text-sm text-muted-foreground lg:px-6">{r.description}</p> : null}
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
