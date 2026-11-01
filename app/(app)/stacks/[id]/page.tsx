import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon } from "lucide-react"

import { StackActions } from "@/components/gantry/stack-actions"
import { ConfigurationCard, GitCard, LastRunCard, StackServicesCard, WebhookCard } from "@/components/gantry/stack-detail"
import { StackStatusBadge } from "@/components/gantry/stacks-table"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getI18n } from "@/lib/i18n/server"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getDocker, getPermissions } from "@/lib/server/environments"
import { getStack, PROJECT_LABEL } from "@/lib/server/stacks"
import { getStackGit, publicGitInfo } from "@/lib/server/stacks/git-records"
import { summarizeProject } from "@/lib/server/stacks/views"
import { tryDocker } from "@/lib/server/views"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.common.fields.stack }
}

export default async function StackPage({ params }: PageProps<"/stacks/[id]">) {
  const user = await requireUser()
  const { t, format, timeAgo } = await getI18n()
  const text = t.stacks.detail
  const isManager = (await getPermissions()).manage
  // Git credentials and webhook secrets stay with global administrators.
  const isAdmin = user.role === "admin"
  const { id } = await params
  if (!/^\d{1,10}$/.test(id)) notFound()

  const [stack, env] = await Promise.all([getStack(Number(id)), getCurrentEnvironment()])
  if (!stack) notFound()

  if (!env || stack.environment_id !== env.id) {
    return (
      <PageBody>
        <BackLink />
        <div className="px-4 lg:px-6">
          <Card>
            <CardHeader>
              <CardTitle>{text.otherEnvironmentTitle}</CardTitle>
              <CardDescription>{text.otherEnvironmentDescription}</CardDescription>
            </CardHeader>
          </Card>
        </div>
      </PageBody>
    )
  }

  const result = await tryDocker(async () =>
    (await getDocker()).listContainers(true).then((list) => list.filter((c) => c.Labels?.[PROJECT_LABEL] === stack.name))
  )
  const containers = result.data ?? []
  const summary = summarizeProject(containers)

  // Never the credentials or webhook secret: only what publicGitInfo exposes.
  const gitRow = await getStackGit(stack.id)
  const git = gitRow ? publicGitInfo(gitRow) : null

  return (
    <PageBody>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 lg:px-6">
        <div className="grid gap-1">
          <BackLink inline />
          <h2 className="flex flex-wrap items-center gap-3 text-xl font-semibold tracking-tight">
            {stack.name}
            {result.error === undefined ? (
              <StackStatusBadge status={summary.status} running={summary.running} total={summary.total} />
            ) : null}
          </h2>
          <p className="text-sm text-muted-foreground">
            {format(text.meta, {
              environment: env.name,
              user: stack.created_by,
              created: timeAgo(stack.created_at),
              updated: timeAgo(stack.updated_at),
            })}
          </p>
        </div>
        {isManager && result.error === undefined ? (
          <StackActions
            id={stack.id}
            name={stack.name}
            running={summary.running}
            total={summary.total}
            git={git !== null}
            canSaveTemplate={user.role === "admin"}
          />
        ) : null}
      </div>

      {result.error !== undefined ? <DockerUnavailable message={result.error} /> : null}

      <div className="grid gap-4 px-4 lg:px-6">
        {git ? <GitCard stackId={stack.id} git={git} isAdmin={isAdmin} /> : null}
        {result.error === undefined ? <StackServicesCard stack={stack} containers={containers} summary={summary} /> : null}
        <LastRunCard stack={stack} isManager={isManager} />
        {isAdmin && git ? <WebhookCard stackId={stack.id} git={git} /> : null}
        <ConfigurationCard stack={stack} git={git} isManager={isManager} />
      </div>
    </PageBody>
  )
}

async function BackLink({ inline }: { inline?: boolean }) {
  const { t } = await getI18n()
  const link = (
    <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
      <Link href="/stacks">
        <ArrowLeftIcon data-icon="inline-start" />
        {t.nav.pages.stacks}
      </Link>
    </Button>
  )
  return inline ? link : <div className="px-4 lg:px-6">{link}</div>
}
