import "server-only"

import { FolderIcon, ScrollTextIcon, TerminalSquareIcon } from "lucide-react"

import { LogViewer } from "@/components/gantry/container-detail-client"
import { ContainerFiles } from "@/components/gantry/container-files"
import { ExecConsole } from "@/components/gantry/exec-console"
import { ContainerImageScan } from "@/components/gantry/image-scan-server"
import { Mono } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { commandLine, initialContainerTab, portBindingLines, proxyDomainUrl, splitEnvEntry } from "@/lib/container-detail"
import { getI18n } from "@/lib/i18n/server"
import type { ContainerUpdate } from "@/lib/image-updates"
import type { Permissions } from "@/lib/permissions"
import type { ContainerInspect } from "@/lib/server/docker/api"
import type { StoredHost } from "@/lib/server/proxy"

// Sections of the container page (app/(app)/containers/[id]/page.tsx).

/** Image (update, scan), proxied domains, times, restart policy, command, ports and networks. */
export async function ContainerOverviewCard({
  c,
  update,
  domains,
}: {
  c: ContainerInspect
  update: ContainerUpdate | undefined
  /** Proxy hosts pointing at this container. */
  domains: StoredHost[]
}) {
  const i18n = await getI18n()
  const { t, format } = i18n
  const text = t.containers.detail
  const ports = portBindingLines(c.HostConfig.PortBindings)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{text.overview}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[minmax(6rem,8rem)_1fr] gap-x-4 gap-y-2 text-sm">
          <Row label={t.common.fields.image}>
            <span className="flex flex-wrap items-center gap-1.5">
              <Mono>{c.Config.Image}</Mono>
              {update?.status === "update" ? (
                <Badge
                  variant="outline"
                  className="border-amber-500/50 px-1.5 text-amber-700 dark:text-amber-400"
                  data-testid="update-badge"
                  title={format(t.containers.updateTitle, { reference: update.reference })}
                >
                  {t.containers.updateAvailable}
                </Badge>
              ) : null}
            </span>
          </Row>
          <Row label={text.vulnerabilities}>
            <ContainerImageScan imageId={c.Image} name={c.Config.Image} />
          </Row>
          {domains.length ? (
            <Row label={text.domains}>
              <span className="flex flex-col">
                {domains.flatMap((h) =>
                  h.domains.map((d) => (
                    <a
                      key={`${h.id}-${d}`}
                      href={proxyDomainUrl(h, d)}
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
          <Row label={t.common.fields.created}>{i18n.formatDate(c.Created)}</Row>
          <Row label={text.started}>{c.State.Running ? i18n.formatDate(c.State.StartedAt) : "—"}</Row>
          {!c.State.Running && !c.State.FinishedAt.startsWith("0001") ? (
            <Row label={text.exited}>
              {format(text.exitedAt, { date: i18n.formatDate(c.State.FinishedAt), code: c.State.ExitCode })}
            </Row>
          ) : null}
          {c.State.Health ? <Row label={text.health}>{c.State.Health.Status}</Row> : null}
          <Row label={text.restartPolicy}>
            {format(text.restartCount, { policy: c.HostConfig.RestartPolicy.Name || "no", count: c.RestartCount })}
          </Row>
          <Row label={text.command}>
            <Mono>{commandLine(c.Config.Entrypoint, c.Config.Cmd)}</Mono>
          </Row>
          <Row label={t.common.fields.ports}>
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
          <Row label={text.networks}>
            {Object.entries(c.NetworkSettings.Networks).map(([net, n]) => (
              <div key={net}>
                {net} {n.IPAddress ? <Mono className="text-muted-foreground">{n.IPAddress}</Mono> : null}
              </div>
            ))}
          </Row>
        </dl>
      </CardContent>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

export async function ContainerMountsCard({ mounts }: { mounts: ContainerInspect["Mounts"] }) {
  const { t } = await getI18n()
  const text = t.containers.detail
  return (
    <Card>
      <CardHeader>
        <CardTitle>{text.mounts}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {mounts.length === 0 ? <p className="text-muted-foreground">{text.noMounts}</p> : null}
        {mounts.map((m) => (
          <div key={m.Destination} className="rounded-lg border p-2">
            <Mono className="block">{m.Destination}</Mono>
            <span className="text-xs text-muted-foreground">
              {m.Type} · {m.Name ?? m.Source} · {m.RW ? text.readWrite : text.readOnly}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

/** Environment variables; values may hold secrets, so only managers (and administrators) see them. */
export async function ContainerEnvCard({ env, showValues }: { env: string[] | null; showValues: boolean }) {
  const { t } = await getI18n()
  const text = t.containers.detail
  return (
    <Card className="@4xl/main:col-span-2">
      <CardHeader>
        <CardTitle>{text.envVars}</CardTitle>
      </CardHeader>
      <CardContent>
        {env?.length ? (
          <div className="grid gap-1 font-mono text-xs">
            {env.map((e) => {
              const { key, value } = splitEnvEntry(e)
              return (
                <div key={e} className="grid gap-x-3 break-all max-sm:gap-y-0.5 sm:grid-cols-[minmax(8rem,16rem)_1fr]">
                  <span className="font-medium">{key}</span>
                  <span className="text-muted-foreground">{showValues ? value : "••••••"}</span>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{text.noEnv}</p>
        )}
      </CardContent>
    </Card>
  )
}

/** Logs and files for operators, the console for managers; a note for viewers. */
export async function ContainerTabs({
  c,
  can,
  tab,
}: {
  c: ContainerInspect
  can: Permissions
  /** ?tab= of the page. */
  tab: string | string[] | undefined
}) {
  const { t } = await getI18n()
  const text = t.containers.detail
  if (!can.operate) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="logs-hidden">
        {text.logsHidden}
      </p>
    )
  }
  return (
    <Tabs defaultValue={initialContainerTab(tab, can.manage)} className="gap-4">
      <TabsList>
        <TabsTrigger value="logs">
          <ScrollTextIcon />
          {text.logs}
        </TabsTrigger>
        <TabsTrigger value="files">
          <FolderIcon />
          {text.files}
        </TabsTrigger>
        {can.manage ? (
          <TabsTrigger value="console">
            <TerminalSquareIcon />
            {text.console}
          </TabsTrigger>
        ) : null}
      </TabsList>
      <TabsContent value="logs">
        <LogViewer id={c.Id} />
      </TabsContent>
      <TabsContent value="files">
        <ContainerFiles container={c} can={can} />
      </TabsContent>
      {/* Stay mounted so switching tabs doesn't end the shell session. */}
      {can.manage ? (
        <TabsContent value="console" forceMount className="data-[state=inactive]:hidden">
          <ExecConsole containerId={c.Id} running={c.State.Running && !c.State.Paused} />
        </TabsContent>
      ) : null}
    </Tabs>
  )
}
