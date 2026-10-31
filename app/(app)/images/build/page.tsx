import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { ImageBuildForm } from "@/components/gantry/image-build-form"
import { ImageBuildHistory, type BuildHistoryRow } from "@/components/gantry/image-builds"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { EMPTY_BUILD_FORM, type BuildFormValues } from "@/lib/image-build"
import { KUBERNETES_ENVIRONMENT } from "@/lib/messages"
import type { I18n } from "@/lib/i18n"
import { getI18n } from "@/lib/i18n/server"
import { requirePermission } from "@/lib/server/action"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { getBuild, listBuilds, type BuildRecord, type BuildSummary } from "@/lib/server/images/builds"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.images.build.title }
}

const lines = (record: Record<string, string>) =>
  Object.entries(record)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")

/** Form values for a rebuild: the earlier build's source and options (no credentials, no archive). */
function rebuildValues(build: BuildRecord): BuildFormValues {
  const { source, options } = build
  return {
    ...EMPTY_BUILD_FORM,
    kind: source.kind,
    ...(source.kind === "editor" ? { dockerfile: source.dockerfile, files: source.files } : {}),
    ...(source.kind === "git"
      ? { url: source.url, ref: source.ref, context: source.context, gitDockerfile: source.dockerfile }
      : {}),
    ...(source.kind === "upload" ? { uploadDockerfile: source.dockerfile } : {}),
    tags: options.tags.join("\n"),
    buildArgs: lines(options.buildArgs),
    labels: lines(options.labels),
    target: options.target,
    noCache: options.noCache,
    pull: options.pull,
    push: options.push,
  }
}

function duration(b: BuildSummary, { t, format }: I18n) {
  if (!b.finishedAt) return null
  const s = Math.max(0, Math.round((Date.parse(b.finishedAt) - Date.parse(b.startedAt)) / 1000))
  return s >= 60
    ? format(t.images.build.durationMinutes, { minutes: Math.floor(s / 60), seconds: s % 60 })
    : format(t.images.build.durationSeconds, { seconds: s })
}

export default async function BuildImagePage({ searchParams }: PageProps<"/images/build">) {
  await requirePermission("manage")
  const i18n = await getI18n()
  const { t } = i18n
  const env = await getCurrentEnvironment()
  const { from } = await searchParams
  const fromId = typeof from === "string" && /^\d{1,12}$/.test(from) ? Number(from) : null

  const header = (
    <div className="grid gap-1 px-4 lg:px-6">
      <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
        <Link href="/images">
          <ArrowLeftIcon data-icon="inline-start" />
          {t.nav.pages.images}
        </Link>
      </Button>
      <h2 className="text-xl font-semibold tracking-tight">{t.images.build.title}</h2>
      {env && env.type !== "kubernetes" ? (
        <p className="text-sm text-muted-foreground">
          {i18n.rich(t.images.build.description, { environment: <span className="font-medium text-foreground">{env.name}</span> })}
        </p>
      ) : null}
    </div>
  )

  if (!env || env.type === "kubernetes") {
    return (
      <PageBody>
        {header}
        <DockerUnavailable message={env ? KUBERNETES_ENVIRONMENT : "No Docker environment configured"} />
      </PageBody>
    )
  }

  const [builds, rebuild] = await Promise.all([listBuilds(env.id), fromId ? getBuild(env.id, fromId) : null])
  const rows: BuildHistoryRow[] = builds.map((b) => ({
    id: b.id,
    username: b.username,
    sourceKind: b.sourceKind,
    sourceSummary: b.sourceSummary,
    tags: b.tags,
    status: b.status,
    error: b.error,
    imageId: b.imageId,
    startedLabel: i18n.timeAgo(b.startedAt),
    duration: duration(b, i18n),
  }))

  return (
    <PageBody>
      {header}
      <ImageBuildForm
        // A new form (fresh state) for each rebuild source.
        key={rebuild?.id ?? "new"}
        initial={rebuild ? rebuildValues(rebuild) : EMPTY_BUILD_FORM}
        rebuildOf={rebuild?.id}
      />
      <div className="px-4 lg:px-6">
        <Card>
          <CardHeader>
            <CardTitle>{t.images.build.recentBuilds}</CardTitle>
            <CardDescription>{i18n.format(t.images.build.recentBuildsDescription, { environment: env.name })}</CardDescription>
          </CardHeader>
          <CardContent>
            <ImageBuildHistory builds={rows} />
          </CardContent>
        </Card>
      </div>
    </PageBody>
  )
}
