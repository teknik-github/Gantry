import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, TriangleAlertIcon } from "lucide-react"

import { FindingsTable, RescanButton, SeverityBadges } from "@/components/gantry/image-scan-ui"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, Mono } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { shortId } from "@/lib/format"
import { getI18n } from "@/lib/i18n/server"
import { requirePermission } from "@/lib/server/action"
import { getCurrentEnvironment, getDocker, getPermissions } from "@/lib/server/environments"
import { scanDetails } from "@/lib/server/image-scans"
import { tryDocker } from "@/lib/server/views"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.images.findings.pageTitle }
}

export default async function ImageVulnerabilitiesPage({ params }: PageProps<"/images/vulnerabilities/[id]">) {
  await requirePermission("view")
  const { t, format, formatBytes, formatDate, timeAgo } = await getI18n()
  const text = t.images.findings
  const { id } = await params
  if (!/^[a-f0-9]{64}$/.test(id)) notFound()
  const imageId = `sha256:${id}`

  const env = await getCurrentEnvironment()
  if (!env || env.type === "kubernetes") {
    return (
      <PageBody>
        <DockerUnavailable message={text.dockerOnly} />
      </PageBody>
    )
  }
  const [details, can, image] = await Promise.all([
    scanDetails(env.id, imageId),
    getPermissions(),
    // One inspect (fast) for the name and size; the image may be gone.
    tryDocker(async () => (await getDocker()).inspectImage(imageId) as Promise<{ RepoTags: string[] | null; Size?: number }>),
  ])
  const tags = (image.data?.RepoTags ?? []).filter((tag) => tag !== "<none>:<none>")
  const name = tags[0] ?? details?.reference ?? shortId(imageId)
  if (!details && image.error !== undefined) notFound()

  return (
    <PageBody>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 lg:px-6">
        <div className="grid gap-1">
          <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
            <Link href="/images">
              <ArrowLeftIcon data-icon="inline-start" />
              {t.nav.pages.images}
            </Link>
          </Button>
          <h2 className="text-xl font-semibold tracking-tight">{format(t.images.scan.vulnerabilitiesOf, { name })}</h2>
          <Mono className="text-muted-foreground">
            {shortId(imageId)}
            {image.data?.Size ? ` · ${formatBytes(image.data.Size)}` : ""}
            {image.error !== undefined ? text.goneFromEnvironment : ""}
          </Mono>
        </div>
        {can.operate && image.error === undefined ? <RescanButton imageId={imageId} name={name} pending={Boolean(details?.pending)} /> : null}
      </div>

      <div className="px-4 lg:px-6">
        <Card>
          <CardContent className="flex flex-col gap-3 text-sm">
            {details?.scannedAt ? (
              <>
                <SeverityBadges counts={details.counts} />
                <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-1.5" data-testid="scan-meta">
                  <dt className="text-muted-foreground">{text.scanned}</dt>
                  <dd>
                    {format(text.scannedAt, { date: formatDate(details.scannedAt), ago: timeAgo(details.scannedAt) })}
                    {details.durationMs ? format(text.took, { seconds: Math.round(details.durationMs / 1000) }) : ""}
                  </dd>
                  <dt className="text-muted-foreground">{text.scanner}</dt>
                  <dd>Trivy {details.trivyVersion ?? text.unknownVersion}</dd>
                  <dt className="text-muted-foreground">{text.database}</dt>
                  <dd>{details.dbVersion ? format(text.databaseUpdated, { date: formatDate(details.dbVersion) }) : text.unknown}</dd>
                  {details.os ? (
                    <>
                      <dt className="text-muted-foreground">{text.os}</dt>
                      <dd>{details.os}</dd>
                    </>
                  ) : null}
                  {details.reference ? (
                    <>
                      <dt className="text-muted-foreground">{text.scannedAs}</dt>
                      <dd>
                        <Mono>{details.reference}</Mono>
                      </dd>
                    </>
                  ) : null}
                </dl>
                {details.truncated ? (
                  <p className="text-xs text-muted-foreground">
                    {format(text.truncated, { count: details.findings.length })}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground" data-testid="scan-none">
                {details?.pending ? text.firstScanRunning : text.notScanned}
                {!details?.pending && !can.operate ? text.needsOperator : ""}
              </p>
            )}
            {details?.error ? (
              <p className="flex items-start gap-2 text-destructive" data-testid="scan-error">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                <span>
                  {format(text.lastScanFailed, { when: details.attemptedAt ? timeAgo(details.attemptedAt) : "", error: details.error })}
                </span>
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>

      {details?.scannedAt ? <FindingsTable findings={details.findings} /> : null}
    </PageBody>
  )
}
