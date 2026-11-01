import type { Metadata } from "next"

import { AutoUpdateContainers, AutoUpdateResults, AutoUpdateSchedule } from "@/components/gantry/auto-update-ui"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { requirePermission } from "@/lib/server/action"
import {
  AUTO_UPDATE_LABEL,
  containerNameOf,
  enrolledNames,
  enrolment,
  getAutoUpdateSettings,
  isAutoUpdateRunning,
  lastAutoUpdateRun,
} from "@/lib/server/auto-update"
import { getCurrentEnvironment, getDocker } from "@/lib/server/environments"
import { updatesFor } from "@/lib/server/image-updates"
import { tryDocker } from "@/lib/server/views"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.autoUpdate }
}

export default async function AutoUpdatePage() {
  // Managers turn auto-update on per container in their environment; the
  // schedule and the results (which span every environment) are for admins.
  const user = await requirePermission("manage")
  const isAdmin = user.role === "admin"
  const env = await getCurrentEnvironment()
  const [settings, lastRun] = await Promise.all([getAutoUpdateSettings(), lastAutoUpdateRun()])
  const names = env ? await enrolledNames(env.id) : new Set<string>()

  const result = await tryDocker(async () => {
    const api = await getDocker()
    const containers = await api.listContainers(true)
    if (!env) return { containers, refs: new Map<string, string>(), updates: new Map() }
    return { containers, ...(await updatesFor(api, env.id, containers)) }
  })

  const { t, format, timeAgo } = await getI18n()
  const now = new Date()
  return (
    <PageBody>
      <PageHeader
        title={t.nav.pages.autoUpdate}
        description={format(t.autoUpdate.description, { label: AUTO_UPDATE_LABEL })}
      />
      {isAdmin ? (
        <AutoUpdateSchedule
          enabled={settings.enabled}
          time={settings.time}
          serverTime={now.toTimeString().slice(0, 5)}
          timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
          running={isAutoUpdateRunning()}
        />
      ) : null}
      {isAdmin && lastRun ? (
        <AutoUpdateResults
          trigger={lastRun.trigger}
          finishedLabel={timeAgo(lastRun.finishedAt)}
          results={lastRun.results.map((r, i) => ({ id: String(i), ...r, message: r.message ?? "" }))}
        />
      ) : null}
      <PageHeader
        title={format(t.autoUpdate.containersOn, { name: env?.name ?? t.autoUpdate.thisEnvironment })}
        description={t.autoUpdate.containersDescription}
      />
      {result.error !== undefined ? (
        <DockerUnavailable message={result.error} />
      ) : (
        <AutoUpdateContainers
          data={result.data.containers.map((c) => {
            const update = result.data.updates.get(c.Id)
            return {
              id: c.Id,
              name: containerNameOf(c),
              image: result.data.refs.get(c.Id) ?? c.Image,
              state: c.State,
              enrolment: enrolment(c, names),
              update: update?.status ?? null,
              stack: c.Labels?.["com.docker.compose.project"] ?? null,
            }
          })}
        />
      )}
    </PageBody>
  )
}
