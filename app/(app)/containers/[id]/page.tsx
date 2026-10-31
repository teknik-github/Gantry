import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, ScrollTextIcon, TerminalSquareIcon } from "lucide-react"

import { ContainerActions, LogViewer } from "@/components/gantry/container-detail-client"
import { ExposeContainerDialog } from "@/components/gantry/proxy-ui"
import type { RecreateInfo } from "@/components/gantry/container-edit-dialog"
import { ExecConsole } from "@/components/gantry/exec-console"
import { ContainerImageScan } from "@/components/gantry/image-scan-server"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable, Mono, StateBadge } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatDate, shortId } from "@/lib/format"
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
  const exposedPorts = [...new Set(Object.keys(c.Config.ExposedPorts ?? {}).map((p) => Number(p.split("/")[0])))].filter(Boolean)
  const can = await getPermissions()
  const recreate = can.manage ? await recreateInfo(c as unknown as RecreateInspect) : undefined
  const ports = Object.entries(c.HostConfig.PortBindings ?? {}).flatMap(([container, binds]) =>
    (binds ?? []).map((b) => `${b.HostIp ? `${b.HostIp}:` : ""}${b.HostPort} → ${container}`)
  )

  return (
    <PageBody>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 lg:px-6">
        <div className="grid gap-1">
          <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
            <Link href="/containers">
              <ArrowLeftIcon data-icon="inline-start" />
              Containers
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
            <ExposeContainerDialog target={name} ports={exposedPorts} proxyOff={!proxy || proxy.settings.mode === "off"} />
          ) : null}
          <ContainerActions id={c.Id} name={name} state={c.State.Status} can={can} recreate={recreate} />
        </div>
      </div>

      <div className="grid gap-4 px-4 lg:px-6 @4xl/main:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Overview</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              <Row label="Image">
                <span className="flex flex-wrap items-center gap-1.5">
                  <Mono>{c.Config.Image}</Mono>
                  {update?.status === "update" ? (
                    <Badge
                      variant="outline"
                      className="border-amber-500/50 px-1.5 text-amber-700 dark:text-amber-400"
                      data-testid="update-badge"
                      title={`A newer image is available for ${update.reference}`}
                    >
                      update available
                    </Badge>
                  ) : null}
                </span>
              </Row>
              <Row label="Vulnerabilities">
                <ContainerImageScan imageId={c.Image} name={c.Config.Image} />
              </Row>
              {domains.length ? (
                <Row label="Domains">
                  <span className="flex flex-col">
                    {domains.flatMap((h) =>
                      h.domains.map((d) => (
                        <a
                          key={`${h.id}-${d}`}
                          href={`${h.tls === "off" ? "http" : "https"}://${d.replace(/^\*\./, "www.")}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className={h.enabled ? "underline-offset-4 hover:underline" : "text-muted-foreground line-through"}
                        >
                          {d} → :{h.port}
                        </a>
                      ))
                    )}
                  </span>
                </Row>
              ) : null}
              <Row label="Created">{formatDate(c.Created)}</Row>
              <Row label="Started">{c.State.Running ? formatDate(c.State.StartedAt) : "—"}</Row>
              {!c.State.Running && !c.State.FinishedAt.startsWith("0001") ? (
                <Row label="Exited">
                  {formatDate(c.State.FinishedAt)} (code {c.State.ExitCode})
                </Row>
              ) : null}
              {c.State.Health ? <Row label="Health">{c.State.Health.Status}</Row> : null}
              <Row label="Restart policy">
                {c.HostConfig.RestartPolicy.Name || "no"} · restarted {c.RestartCount}×
              </Row>
              <Row label="Command">
                <Mono>{[...(c.Config.Entrypoint ?? []), ...(c.Config.Cmd ?? [])].join(" ") || "—"}</Mono>
              </Row>
              <Row label="Ports">
                {ports.length ? (
                  <div className="flex flex-col gap-0.5">
                    {ports.map((p) => (
                      <Mono key={p}>{p}</Mono>
                    ))}
                  </div>
                ) : (
                  "—"
                )}
              </Row>
              <Row label="Networks">
                {Object.entries(c.NetworkSettings.Networks).map(([net, n]) => (
                  <div key={net}>
                    {net} {n.IPAddress ? <Mono className="text-muted-foreground">{n.IPAddress}</Mono> : null}
                  </div>
                ))}
              </Row>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Mounts</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {c.Mounts.length === 0 ? <p className="text-muted-foreground">No mounts.</p> : null}
            {c.Mounts.map((m) => (
              <div key={m.Destination} className="rounded-lg border p-2">
                <Mono className="block">{m.Destination}</Mono>
                <span className="text-xs text-muted-foreground">
                  {m.Type} · {m.Name ?? m.Source} · {m.RW ? "read-write" : "read-only"}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="@4xl/main:col-span-2">
          <CardHeader>
            <CardTitle>Environment variables</CardTitle>
          </CardHeader>
          <CardContent>
            {c.Config.Env?.length ? (
              <div className="grid gap-1 font-mono text-xs">
                {c.Config.Env.map((e) => {
                  const [key, ...rest] = e.split("=")
                  return (
                    <div key={e} className="grid grid-cols-[minmax(8rem,16rem)_1fr] gap-3 break-all">
                      <span className="font-medium">{key}</span>
                      {/* Values may hold secrets; only managers (and administrators) see them. */}
                      <span className="text-muted-foreground">{can.manage ? rest.join("=") : "••••••"}</span>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">None.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="px-4 lg:px-6">
        {can.manage ? (
          <Tabs defaultValue={tab === "console" ? "console" : "logs"} className="gap-4">
            <TabsList>
              <TabsTrigger value="logs">
                <ScrollTextIcon />
                Logs
              </TabsTrigger>
              <TabsTrigger value="console">
                <TerminalSquareIcon />
                Console
              </TabsTrigger>
            </TabsList>
            <TabsContent value="logs">
              <LogViewer id={c.Id} />
            </TabsContent>
            {/* Stay mounted so switching tabs doesn't end the shell session. */}
            <TabsContent value="console" forceMount className="data-[state=inactive]:hidden">
              <ExecConsole containerId={c.Id} running={c.State.Running && !c.State.Paused} />
            </TabsContent>
          </Tabs>
        ) : can.operate ? (
          <LogViewer id={c.Id} />
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="logs-hidden">
            Logs need the operator role in this environment.
          </p>
        )}
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}
