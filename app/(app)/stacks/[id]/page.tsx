import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, GitBranchIcon, GitCommitHorizontalIcon } from "lucide-react"

import { StackActions } from "@/components/gantry/stack-actions"
import { StackEditor } from "@/components/gantry/stack-editor"
import { GitSourceDialog, WebhookPanel } from "@/components/gantry/stack-git"
import { StackStatusBadge } from "@/components/gantry/stacks-table"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, Mono, StateBadge } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { shortSha } from "@/lib/git-stacks"
import { getI18n } from "@/lib/i18n/server"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getDocker, getPermissions } from "@/lib/server/environments"
import { getStack, isStackBusy, PROJECT_LABEL } from "@/lib/server/stacks"
import { getStackGit, publicGitInfo, type GitStackInfo } from "@/lib/server/stacks/git-records"
import { summarizeProject } from "@/lib/server/stacks/views"
import { tryDocker } from "@/lib/server/views"
import { parseDotenv, validateCompose } from "@/lib/stacks"
import { cn } from "@/lib/utils"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.common.fields.stack }
}

export default async function StackPage({ params }: PageProps<"/stacks/[id]">) {
  const user = await requireUser()
  const { t, format, rich, timeAgo, formatDate } = await getI18n()
  const text = t.stacks.detail
  const operations: Record<string, string> = t.stacks.operations
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
  const images = new Map(containers.map((c) => [c.Id, { image: c.Image, status: c.Status }]))

  const check = validateCompose(stack.compose)
  const defined = check.ok ? check.services : []
  const withContainers = new Set(summary.containers.map((c) => c.service))
  const notCreated = defined.filter((s) => !withContainers.has(s))

  const changedSinceRun = stack.last_run_at !== null && stack.updated_at > stack.last_run_at
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

        {result.error === undefined ? (
          <Card>
            <CardHeader>
              <CardTitle>{text.services}</CardTitle>
              <CardDescription>
                {rich(text.servicesDescription, { label: <Mono>{`${PROJECT_LABEL}=${stack.name}`}</Mono> })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader className="bg-muted">
                    <TableRow>
                      <TableHead>{text.service}</TableHead>
                      <TableHead>{text.container}</TableHead>
                      <TableHead>{t.common.fields.state}</TableHead>
                      <TableHead>{t.common.fields.image}</TableHead>
                      <TableHead>{t.common.fields.status}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.containers.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="font-medium">{c.service || "—"}</TableCell>
                        <TableCell>
                          <Link href={`/containers/${c.id}`} className="underline-offset-4 hover:underline">
                            {c.name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <StateBadge state={c.state} />
                        </TableCell>
                        <TableCell>
                          <Mono className="block max-w-64 truncate">{images.get(c.id)?.image}</Mono>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{images.get(c.id)?.status}</TableCell>
                      </TableRow>
                    ))}
                    {notCreated.map((s) => (
                      <TableRow key={`svc-${s}`}>
                        <TableCell className="font-medium">{s}</TableCell>
                        <TableCell className="text-muted-foreground">—</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-muted-foreground">
                            {text.notCreated}
                          </Badge>
                        </TableCell>
                        <TableCell />
                        <TableCell />
                      </TableRow>
                    ))}
                    {summary.containers.length === 0 && notCreated.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="h-16 text-center text-muted-foreground">
                          {text.noContainers}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card className={cn(stack.last_status === "error" && "border-destructive/40")}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {text.lastRun}
              {stack.last_status ? (
                <Badge variant={stack.last_status === "error" ? "destructive" : "secondary"}>
                  {stack.last_status === "error" ? text.failed : text.succeeded}
                </Badge>
              ) : null}
              {isStackBusy(stack.id) ? <Badge variant="outline">{text.runningNow}</Badge> : null}
            </CardTitle>
            <CardDescription>
              {stack.last_run_at ? (
                <>
                  {rich(text.lastRunBy, {
                    action: operations[stack.last_action ?? ""] ?? stack.last_action,
                    user: stack.last_run_by,
                    time: (
                      <time dateTime={stack.last_run_at} title={formatDate(stack.last_run_at)}>
                        {timeAgo(stack.last_run_at)}
                      </time>
                    ),
                  })}
                  {changedSinceRun ? text.editedSince : null}
                </>
              ) : (
                text.neverDeployed
              )}
            </CardDescription>
          </CardHeader>
          {/* compose's output can quote the compose file (e.g. interpolation errors): managers only. */}
          {stack.last_output && isManager ? (
            <CardContent>
              <pre
                data-testid="stack-output"
                className="max-h-[28rem] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
              >
                {stack.last_output}
              </pre>
            </CardContent>
          ) : null}
        </Card>

        {isAdmin && git ? (
          <Card>
            <CardHeader>
              <CardTitle>{text.webhook}</CardTitle>
              <CardDescription>{format(text.webhookDescription, { ref: git.ref })}</CardDescription>
            </CardHeader>
            <CardContent>
              <WebhookPanel stackId={stack.id} webhookId={git.webhookId} gitRef={git.ref} />
            </CardContent>
          </Card>
        ) : null}

        {isManager ? (
          <Card>
            <CardHeader>
              <CardTitle>{text.configuration}</CardTitle>
              <CardDescription>{text.configurationDescription}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <StackEditor
                stack={{ id: stack.id, name: stack.name, compose: stack.compose, env: stack.env }}
                gitComposePath={git?.composePath}
              />
              {git ? (
                <div className="grid gap-2">
                  <span className="text-sm font-medium">
                    {git.composePath} <span className="font-normal text-muted-foreground">{text.fromRepository}</span>
                  </span>
                  <pre
                    data-testid="git-compose"
                    className="max-h-[28rem] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
                  >
                    {stack.compose || text.notFetched}
                  </pre>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{text.configuration}</CardTitle>
              <CardDescription>{text.secretsHidden}</CardDescription>
            </CardHeader>
            <CardContent className="text-sm">
              <EnvKeys env={stack.env} />
            </CardContent>
          </Card>
        )}
      </div>
    </PageBody>
  )
}

async function GitCard({ stackId, git, isAdmin }: { stackId: number; git: GitStackInfo; isAdmin: boolean }) {
  const { t, format, timeAgo, formatDate } = await getI18n()
  const text = t.stacks.detail
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <GitBranchIcon className="size-4" />
          {text.gitRepository}
        </CardTitle>
        <CardDescription className="break-all">
          <Mono>{git.url}</Mono> · <Mono>{git.ref}</Mono> · <Mono>{git.composePath}</Mono>
        </CardDescription>
        {isAdmin ? (
          <CardAction>
            <GitSourceDialog
              stackId={stackId}
              source={{
                url: git.url,
                ref: git.ref,
                composePath: git.composePath,
                hasCredentials: git.hasCredentials,
                pollMinutes: git.pollMinutes,
              }}
            />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-2" data-testid="git-commit">
          <GitCommitHorizontalIcon className="size-4 text-muted-foreground" />
          {git.commit ? (
            <>
              <span className="text-muted-foreground">{text.deployed}</span>
              <Mono className="font-medium">{shortSha(git.commit.sha)}</Mono>
              <span className="min-w-0 truncate font-medium">{git.commit.subject}</span>
              <span className="text-muted-foreground">
                {git.commit.author}
                {git.commit.date ? (
                  <>
                    {" · "}
                    <time dateTime={git.commit.date} title={formatDate(git.commit.date)}>
                      {timeAgo(git.commit.date)}
                    </time>
                  </>
                ) : null}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">{text.noCommit}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          <span>
            {format(text.credentials, { value: git.hasCredentials ? text.credentialsStored : text.credentialsNone })}
          </span>
          <span>{format(text.webhookStatus, { value: git.webhookId ? text.webhookEnabled : text.webhookOff })}</span>
          <span>
            {format(text.polling, {
              value: git.pollMinutes > 0 ? format(text.pollingEvery, { minutes: git.pollMinutes }) : text.pollingOff,
            })}
            {git.pollMinutes > 0 && git.lastCheckedAt ? format(text.lastChecked, { time: timeAgo(git.lastCheckedAt) }) : null}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

async function EnvKeys({ env }: { env: string }) {
  const { t } = await getI18n()
  const { entries } = parseDotenv(env)
  if (entries.length === 0) return <p className="text-muted-foreground">{t.stacks.detail.noEnvironmentVariables}</p>
  return (
    <div className="grid gap-1 font-mono text-xs">
      {entries.map((e, i) => (
        <div key={`${i}-${e.key}`} className="grid grid-cols-[minmax(8rem,16rem)_1fr] gap-3">
          <span className="font-medium">{e.key}</span>
          <span className="text-muted-foreground">••••••</span>
        </div>
      ))}
    </div>
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
