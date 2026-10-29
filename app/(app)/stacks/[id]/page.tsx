import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon } from "lucide-react"

import { StackActions } from "@/components/gantry/stack-actions"
import { StackEditor } from "@/components/gantry/stack-editor"
import { StackStatusBadge } from "@/components/gantry/stacks-table"
import { DockerUnavailable, Mono, PageBody, StateBadge } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate, timeAgo } from "@/lib/format"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getDocker } from "@/lib/server/environments"
import { getStack, isStackBusy, PROJECT_LABEL } from "@/lib/server/stacks"
import { summarizeProject } from "@/lib/server/stacks/views"
import { tryDocker } from "@/lib/server/views"
import { parseDotenv, validateCompose } from "@/lib/stacks"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Stack" }

const ACTION_LABELS: Record<string, string> = {
  deploy: "Deploy",
  redeploy: "Pull & redeploy",
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  down: "Down",
}

export default async function StackPage({ params }: PageProps<"/stacks/[id]">) {
  const user = await requireUser()
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
              <CardTitle>Stack is in another environment</CardTitle>
              <CardDescription>
                This stack belongs to a different Docker environment. Switch environments in the sidebar to manage it.
              </CardDescription>
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
            On {env.name} · created by {stack.created_by} {timeAgo(stack.created_at)} · updated{" "}
            {timeAgo(stack.updated_at)}
          </p>
        </div>
        {isAdmin && result.error === undefined ? (
          <StackActions id={stack.id} name={stack.name} running={summary.running} total={summary.total} />
        ) : null}
      </div>

      {result.error !== undefined ? <DockerUnavailable message={result.error} /> : null}

      <div className="grid gap-4 px-4 lg:px-6">
        {result.error === undefined ? (
          <Card>
            <CardHeader>
              <CardTitle>Services</CardTitle>
              <CardDescription>
                Containers labelled <Mono>{`${PROJECT_LABEL}=${stack.name}`}</Mono>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader className="bg-muted">
                    <TableRow>
                      <TableHead>Service</TableHead>
                      <TableHead>Container</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Image</TableHead>
                      <TableHead>Status</TableHead>
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
                            not created
                          </Badge>
                        </TableCell>
                        <TableCell />
                        <TableCell />
                      </TableRow>
                    ))}
                    {summary.containers.length === 0 && notCreated.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="h-16 text-center text-muted-foreground">
                          No containers.
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
              Last run
              {stack.last_status ? (
                <Badge variant={stack.last_status === "error" ? "destructive" : "secondary"}>
                  {stack.last_status === "error" ? "failed" : "succeeded"}
                </Badge>
              ) : null}
              {isStackBusy(stack.id) ? <Badge variant="outline">running now…</Badge> : null}
            </CardTitle>
            <CardDescription>
              {stack.last_run_at ? (
                <>
                  {ACTION_LABELS[stack.last_action ?? ""] ?? stack.last_action} by {stack.last_run_by} ·{" "}
                  <time dateTime={stack.last_run_at} title={formatDate(stack.last_run_at)}>
                    {timeAgo(stack.last_run_at)}
                  </time>
                  {changedSinceRun ? " · the stack was edited since" : null}
                </>
              ) : (
                "This stack hasn't been deployed from Gantry yet."
              )}
            </CardDescription>
          </CardHeader>
          {stack.last_output ? (
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

        {isAdmin ? (
          <Card>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
              <CardDescription>Saving doesn&apos;t touch running containers until you deploy.</CardDescription>
            </CardHeader>
            <CardContent>
              <StackEditor stack={{ id: stack.id, name: stack.name, compose: stack.compose, env: stack.env }} />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Configuration</CardTitle>
              <CardDescription>
                The compose file and environment values may hold secrets; only administrators can view them.
              </CardDescription>
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

function EnvKeys({ env }: { env: string }) {
  const { entries } = parseDotenv(env)
  if (entries.length === 0) return <p className="text-muted-foreground">No environment variables.</p>
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

function BackLink({ inline }: { inline?: boolean }) {
  const link = (
    <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
      <Link href="/stacks">
        <ArrowLeftIcon data-icon="inline-start" />
        Stacks
      </Link>
    </Button>
  )
  return inline ? link : <div className="px-4 lg:px-6">{link}</div>
}
