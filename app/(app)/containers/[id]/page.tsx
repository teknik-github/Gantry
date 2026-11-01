import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon } from "lucide-react"

import { ContainerActions } from "@/components/gantry/container-detail-client"
import {
  ContainerEnvCard,
  ContainerMountsCard,
  ContainerOverviewCard,
  ContainerTabs,
} from "@/components/gantry/container-detail"
import { ExposeContainerDialog } from "@/components/gantry/proxy-ui"
import type { RecreateInfo } from "@/components/gantry/container-edit-dialog"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, Mono, StateBadge } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { exposedPortNumbers } from "@/lib/container-detail"
import { shortId } from "@/lib/format"
import { getI18n } from "@/lib/i18n/server"
import { requireUser } from "@/lib/server/auth/dal"
import {
  composeProject,
  fixedMountTargets,
  formValuesFromInspect,
  networksEditable,
  recreateBlocker,
  type RecreateInspect,
} from "@/lib/server/docker/recreate"
import { selfContainerIds } from "@/lib/server/docker/self"
import { getCurrentEnvironment, getDocker, getPermissions } from "@/lib/server/environments"
import { updatesFor } from "@/lib/server/image-updates"
import { getProxySettings, listProxyHosts } from "@/lib/server/proxy"
import { tryDocker } from "@/lib/server/views"

export default async function ContainerPage({ params, searchParams }: PageProps<"/containers/[id]">) {
  await requireUser()
  const { t } = await getI18n()
  const { id } = await params
  const { tab } = await searchParams
  if (!/^[a-f0-9]{12,64}$/.test(id)) notFound()

  const env = await getCurrentEnvironment()
  const result = await tryDocker(async () => {
    const api = await getDocker()
    const c = await api.inspectContainer(id)
    // Update status from the last check of its tag (no registry call here).
    const update = env
      ? (await updatesFor(api, env.id, [{ Id: c.Id, Image: c.Config.Image, ImageID: c.Image }], new Map([[c.Id, c.Config.Image]]))).updates.get(c.Id)
      : undefined
    return { c, update }
  })
  if (result.error !== undefined) {
    if (/no such container/i.test(result.error)) notFound()
    return (
      <PageBody>
        <DockerUnavailable message={result.error} />
      </PageBody>
    )
  }

  const { c, update } = result.data
  const name = c.Name.replace(/^\//, "")
  const [proxy, proxyHosts] = env ? await Promise.all([getProxySettings(env.id), listProxyHosts(env.id)]) : [null, []]
  const domains = proxyHosts.filter((h) => h.target === name)
  const can = await getPermissions()
  const recreate = can.manage ? await recreateInfo(c as unknown as RecreateInspect) : undefined

  return (
    <PageBody>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 lg:px-6">
        <div className="grid gap-1">
          <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
            <Link href="/containers">
              <ArrowLeftIcon data-icon="inline-start" />
              {t.nav.pages.containers}
            </Link>
          </Button>
          <h2 className="flex items-center gap-3 text-xl font-semibold tracking-tight">
            {name}
            <StateBadge state={c.State.Status} />
          </h2>
          <Mono className="text-muted-foreground">{shortId(c.Id)}</Mono>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {can.manage ? (
            <ExposeContainerDialog
              target={name}
              ports={exposedPortNumbers(c.Config.ExposedPorts)}
              proxyOff={!proxy || proxy.settings.mode === "off"}
            />
          ) : null}
          <ContainerActions id={c.Id} name={name} state={c.State.Status} can={can} recreate={recreate} />
        </div>
      </div>

      <div className="grid gap-4 px-4 lg:px-6 @4xl/main:grid-cols-2">
        <ContainerOverviewCard c={c} update={update} domains={domains} />
        <ContainerMountsCard mounts={c.Mounts} />
        <ContainerEnvCard env={c.Config.Env} showValues={can.manage} />
      </div>

      <div className="px-4 lg:px-6">
        <ContainerTabs c={c} can={can} tab={tab} />
      </div>
    </PageBody>
  )
}

/** Prefilled edit form and guards. Includes env values: managers only. */
async function recreateInfo(c: RecreateInspect): Promise<RecreateInfo> {
  const editable = networksEditable(c)
  const networks = editable ? await tryDocker(async () => (await getDocker()).listNetworks()) : null
  return {
    values: formValuesFromInspect(c),
    availableNetworks: (networks?.data ?? [])
      .filter((n) => n.Driver !== "host" && n.Driver !== "null" && n.Name !== "ingress")
      .map((n) => n.Name),
    networksEditable: editable,
    networkMode: c.HostConfig.NetworkMode ?? "default",
    composeProject: composeProject(c),
    blocker: recreateBlocker(c, selfContainerIds()),
    entrypoint: (c.Config.Entrypoint ?? []).join(" "),
    fixedMounts: fixedMountTargets(c),
  }
}
