import type { Metadata } from "next"

import {
  ExternalProjectsTable,
  StacksTable,
  type ExternalProjectRow,
  type StackRow,
} from "@/components/gantry/stacks-table"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getDocker, getPermissions } from "@/lib/server/environments"
import { groupByProject, listStacks } from "@/lib/server/stacks"
import { gitStackIds } from "@/lib/server/stacks/git-records"
import { summarizeProject } from "@/lib/server/stacks/views"
import { tryDocker } from "@/lib/server/views"
import { STACK_NAME_RE, validateCompose } from "@/lib/stacks"
import { KUBERNETES_ENVIRONMENT } from "@/lib/messages"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.stacks }
}

export default async function StacksPage() {
  const user = await requireUser()
  const { t, format, timeAgo } = await getI18n()
  const can = await getPermissions()
  const env = await getCurrentEnvironment()
  if (!env) {
    return (
      <PageBody>
        <PageHeader title={t.nav.pages.stacks} />
        <DockerUnavailable message="No Docker environment configured" />
      </PageBody>
    )
  }
  // Stacks are Docker Compose projects.
  if (env.type === "kubernetes") {
    return (
      <PageBody>
        <PageHeader title={t.nav.pages.stacks} />
        <DockerUnavailable message={KUBERNETES_ENVIRONMENT} />
      </PageBody>
    )
  }

  const [stacks, result] = await Promise.all([
    listStacks(env.id),
    tryDocker(async () => (await getDocker()).listContainers(true)),
  ])
  const projects = groupByProject(result.data ?? [])
  const gitIds = await gitStackIds(stacks.map((s) => s.id))

  const rows: StackRow[] = stacks.map((s) => {
    const summary = result.error === undefined ? summarizeProject(projects.get(s.name) ?? []) : null
    const check = validateCompose(s.compose)
    const services = new Set(check.ok ? check.services : [])
    for (const c of summary?.containers ?? []) if (c.service) services.add(c.service)
    return {
      id: s.id,
      name: s.name,
      status: summary?.status ?? "unknown",
      running: summary?.running ?? 0,
      total: summary?.total ?? 0,
      services: [...services],
      createdBy: s.created_by,
      updatedLabel: timeAgo(s.updated_at),
      lastStatus: s.last_status,
      lastAction: s.last_action,
      lastRunLabel: s.last_run_at ? timeAgo(s.last_run_at) : null,
      git: gitIds.has(s.id),
    }
  })

  const managed = new Set(stacks.map((s) => s.name))
  const external: ExternalProjectRow[] = [...projects.entries()]
    .filter(([name]) => !managed.has(name))
    .map(([name, containers]) => {
      const summary = summarizeProject(containers)
      return {
        name,
        status: summary.status,
        running: summary.running,
        total: summary.total,
        containers: summary.containers,
        configFiles: summary.configFiles,
        importable: STACK_NAME_RE.test(name) && Boolean(summary.configFiles),
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <PageBody>
      <PageHeader
        title={t.nav.pages.stacks}
        description={
          result.error === undefined
            ? format(t.stacks.list.descriptionWithExternal, {
                environment: env.name,
                managed: rows.length,
                external: external.length,
              })
            : format(t.stacks.list.description, { environment: env.name, managed: rows.length })
        }
      />
      {result.error !== undefined ? <DockerUnavailable message={result.error} /> : null}
      <StacksTable data={rows} canManage={can.manage} />
      {result.error === undefined ? (
        <>
          <PageHeader
            title={t.stacks.list.externalTitle}
            description={t.stacks.list.externalDescription}
          />
          {/* Importing reads a file path named by container labels: administrators only. */}
          <ExternalProjectsTable data={external} canImport={user.role === "admin"} />
        </>
      ) : null}
    </PageBody>
  )
}
