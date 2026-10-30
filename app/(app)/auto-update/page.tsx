import type { Metadata } from "next"

import { AutoUpdateContainers, AutoUpdateResults, AutoUpdateSchedule } from "@/components/gantry/auto-update-ui"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, PageHeader } from "@/components/gantry/ui"
import { timeAgo } from "@/lib/format"
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

export const metadata: Metadata = { title: "Auto-update" }

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

  const now = new Date()
  return (
    <PageBody>
      <PageHeader
        title="Auto-update"
        description={`Once a day, running containers with auto-update on are updated when their image tag has a newer image (pull & recreate, rolled back on failure). Containers can also opt in with the label ${AUTO_UPDATE_LABEL}=true.`}
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
      <PageHeader title={`Containers on ${env?.name ?? "this environment"}`} description="Turn auto-update on per container. Stopped containers are skipped." />
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
