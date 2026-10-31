"use client"

import Link from "next/link"
import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react"

import { Mono, StateBadge } from "@/components/gantry/ui"
import { STATE_DOT } from "@/components/gantry/topology-nodes"
import { Button } from "@/components/ui/button"
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { I18n } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"
import { cn } from "@/lib/utils"
import type { ContainerNode, TopologyEdge, TopologyGraph, TopologyNode } from "@/lib/topology"

export function conditionLabel(condition: string, t: I18n["t"]) {
  return (t.topology.details.conditions as Record<string, string>)[condition] ?? condition
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  )
}

function ContainerRef({ c, extra }: { c: ContainerNode; extra?: React.ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      <span className={cn("size-2 shrink-0 rounded-full", STATE_DOT[c.state] ?? "bg-muted-foreground")} />
      <Link href={`/containers/${c.dockerId}`} className="truncate font-medium underline-offset-4 hover:underline">
        {c.name}
      </Link>
      {extra ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">{extra}</span> : null}
    </li>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}

export function TopologyDetails({
  graph,
  node,
  onShowProject,
}: {
  graph: TopologyGraph
  node: TopologyNode
  onShowProject: (name: string) => void
}) {
  const i18n = useI18n()
  const { t, format } = i18n
  const d = t.topology.details
  const containers = new Map(graph.containers.map((c) => [c.id, c]))
  const byId = new Map<string, TopologyNode>(
    [...graph.networks, ...graph.volumes, ...graph.binds, ...graph.projects, ...graph.containers].map((n) => [n.id, n])
  )
  const from = (kind: TopologyEdge["kind"]) => graph.edges.filter((e) => e.kind === kind && e.source === node.id)
  const to = (kind: TopologyEdge["kind"]) => graph.edges.filter((e) => e.kind === kind && e.target === node.id)

  switch (node.kind) {
    case "container": {
      const c = node
      const networks = graph.edges.filter((e): e is Extract<TopologyEdge, { kind: "network" }> => e.kind === "network" && e.source === c.id)
      const mounts = graph.edges.filter(
        (e): e is Extract<TopologyEdge, { kind: "volume" | "bind" }> => (e.kind === "volume" || e.kind === "bind") && e.source === c.id
      )
      const requiredBy = to("depends").map((e) => containers.get(e.source)).filter((x): x is ContainerNode => !!x)
      const sharesWith = from("netns").map((e) => containers.get(e.target)).filter((x): x is ContainerNode => !!x)
      const sharedBy = to("netns").map((e) => containers.get(e.source)).filter((x): x is ContainerNode => !!x)
      return (
        <>
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 pr-8">
              <span className="truncate">{c.name}</span>
              <StateBadge state={c.state} />
            </SheetTitle>
            <SheetDescription>{c.status || d.container}</SheetDescription>
          </SheetHeader>
          <div className="grid gap-5 overflow-y-auto px-4 pb-4">
            <Button asChild size="sm" className="w-fit">
              <Link href={`/containers/${c.dockerId}`}>
                {d.openContainer}
                <ArrowRightIcon data-icon="inline-end" />
              </Link>
            </Button>
            <Section title={d.overview}>
              <Field label={d.image}>
                <Mono>{c.image}</Mono>
              </Field>
              <Field label={d.id}>
                <Mono>{c.dockerId.slice(0, 12)}</Mono>
              </Field>
              {c.project ? (
                <Field label={d.compose}>
                  {c.project} / {c.service ?? "?"}
                </Field>
              ) : null}
              {c.networkMode ? (
                <Field label={d.networkMode}>
                  <Mono>{c.networkMode}</Mono>
                </Field>
              ) : null}
            </Section>
            <Section title={d.ports}>
              {c.ports.length ? (
                <div className="flex flex-wrap gap-1">
                  {c.ports.map((p) => (
                    <Mono key={`${p.label}@${p.ip}`} className="rounded bg-muted px-1.5 py-0.5">
                      {p.ip ? `${p.ip}:` : ""}
                      {p.label}
                      {p.published ? "" : d.notPublished}
                    </Mono>
                  ))}
                </div>
              ) : (
                <Empty>{d.noPorts}</Empty>
              )}
            </Section>
            <Section title={d.networks}>
              {networks.length || sharesWith.length ? (
                <ul className="grid gap-2">
                  {networks.map((e) => {
                    const n = byId.get(e.target)
                    return (
                      <li key={e.id} className="grid gap-0.5 text-sm">
                        <Link href="/networks" className="font-medium underline-offset-4 hover:underline">
                          {n?.kind === "network" ? n.name : e.target}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {[e.ip, e.aliases.length ? format(d.aliases, { aliases: e.aliases.join(", ") }) : null]
                            .filter(Boolean)
                            .join(" · ") || d.noAddress}
                        </span>
                      </li>
                    )
                  })}
                  {sharesWith.map((s) => (
                    <ContainerRef key={s.id} c={s} extra={d.sharesStack} />
                  ))}
                </ul>
              ) : (
                <Empty>{d.noNetwork}</Empty>
              )}
            </Section>
            <Section title={d.mounts}>
              {mounts.length ? (
                <ul className="grid gap-2">
                  {mounts.map((e) => {
                    const target = byId.get(e.target)
                    return (
                      <li key={e.id} className="grid gap-0.5 text-sm">
                        {target?.kind === "volume" ? (
                          <Link href="/volumes" className="truncate font-medium underline-offset-4 hover:underline">
                            {target.name}
                          </Link>
                        ) : (
                          <Mono className="truncate">{target?.kind === "bind" ? target.source : e.target}</Mono>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {e.kind === "bind" ? d.bindArrow : "→ "}
                          <Mono>{e.destination}</Mono>
                          {e.readOnly ? d.readOnly : ""}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <Empty>{d.noMounts}</Empty>
              )}
            </Section>
            {c.dependsOn.length || requiredBy.length ? (
              <Section title={d.dependencies}>
                <ul className="grid gap-2">
                  {c.dependsOn.map((dep) => (
                    <li key={dep.service} className="grid gap-1 text-sm">
                      <span>
                        {i18n.rich(d.dependsOn, { service: <span className="font-medium">{dep.service}</span> })}{" "}
                        <span className="text-muted-foreground">
                          ({conditionLabel(dep.condition, t)}
                          {dep.restart ? d.restartsWithIt : ""})
                        </span>
                      </span>
                      {dep.targets.length ? (
                        <ul className="grid gap-1 pl-3">
                          {dep.targets.map((id) => containers.get(id)).map((x) => (x ? <ContainerRef key={x.id} c={x} /> : null))}
                        </ul>
                      ) : (
                        <span className="pl-3 text-xs text-muted-foreground">{d.noServiceContainer}</span>
                      )}
                    </li>
                  ))}
                  {requiredBy.map((s) => (
                    <ContainerRef key={s.id} c={s} extra={d.dependsOnThis} />
                  ))}
                </ul>
              </Section>
            ) : null}
            {sharedBy.length ? (
              <Section title={d.stackSharedWith}>
                <ul className="grid gap-1">
                  {sharedBy.map((s) => (
                    <ContainerRef key={s.id} c={s} />
                  ))}
                </ul>
              </Section>
            ) : null}
          </div>
        </>
      )
    }

    case "network": {
      const n = node
      const attached = to("network").filter((e): e is Extract<TopologyEdge, { kind: "network" }> => e.kind === "network")
      return (
        <>
          <SheetHeader>
            <SheetTitle className="truncate pr-8">{n.name}</SheetTitle>
            <SheetDescription>
              {d.network}
              {n.builtin ? d.builtin : ""}
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-5 overflow-y-auto px-4 pb-4">
            <Button asChild size="sm" variant="outline" className="w-fit">
              <Link href="/networks">
                {d.allNetworks}
                <ExternalLinkIcon data-icon="inline-end" />
              </Link>
            </Button>
            <Section title={d.overview}>
              {n.missing ? <Field label={d.status}>{d.noLongerExists}</Field> : null}
              <Field label={d.driver}>{n.driver}</Field>
              <Field label={d.scope}>{n.scope}</Field>
              {n.subnets.length ? (
                <Field label={d.subnet}>
                  <Mono>{n.subnets.join(", ")}</Mono>
                </Field>
              ) : null}
              <Field label={d.internal}>{n.internal ? d.yes : d.no}</Field>
              {n.project ? <Field label={d.compose}>{n.project}</Field> : null}
              {n.dockerId ? (
                <Field label={d.id}>
                  <Mono>{n.dockerId.slice(0, 12)}</Mono>
                </Field>
              ) : null}
            </Section>
            <Section title={format(d.containers, { count: attached.length })}>
              <ul className="grid gap-1.5">
                {attached.map((e) => {
                  const c = containers.get(e.source)
                  return c ? (
                    <ContainerRef key={e.id} c={c} extra={[e.ip, ...e.aliases].filter(Boolean).join(" · ") || null} />
                  ) : null
                })}
              </ul>
            </Section>
          </div>
        </>
      )
    }

    case "volume":
    case "bind": {
      const isVolume = node.kind === "volume"
      const users = to(node.kind).filter((e): e is Extract<TopologyEdge, { kind: "volume" | "bind" }> => e.kind === "volume" || e.kind === "bind")
      return (
        <>
          <SheetHeader>
            <SheetTitle className="pr-8 break-all">{isVolume ? node.name : node.source}</SheetTitle>
            <SheetDescription>{isVolume ? (node.anonymous ? d.anonymousVolume : d.volume) : d.bindMount}</SheetDescription>
          </SheetHeader>
          <div className="grid gap-5 overflow-y-auto px-4 pb-4">
            {isVolume ? (
              <Button asChild size="sm" variant="outline" className="w-fit">
                <Link href="/volumes">
                  {d.allVolumes}
                  <ExternalLinkIcon data-icon="inline-end" />
                </Link>
              </Button>
            ) : null}
            {node.kind === "volume" ? (
              <Section title={d.overview}>
                {node.missing ? <Field label={d.status}>{d.notListed}</Field> : null}
                <Field label={d.driver}>{node.driver}</Field>
                {node.mountpoint ? (
                  <Field label={d.mountpoint}>
                    <Mono className="break-all">{node.mountpoint}</Mono>
                  </Field>
                ) : null}
                {node.project ? <Field label={d.compose}>{node.project}</Field> : null}
              </Section>
            ) : null}
            <Section title={format(d.mountedBy, { count: users.length })}>
              <ul className="grid gap-1.5">
                {users.map((e) => {
                  const c = containers.get(e.source)
                  return c ? (
                    <ContainerRef key={e.id} c={c} extra={`${e.destination}${e.readOnly ? t.topology.readOnlyShort : ""}`} />
                  ) : null
                })}
              </ul>
            </Section>
          </div>
        </>
      )
    }

    case "project": {
      const p = node
      const members = p.containerIds.map((id) => containers.get(id)).filter((x): x is ContainerNode => !!x)
      const running = members.filter((c) => c.state === "running").length
      return (
        <>
          <SheetHeader>
            <SheetTitle className="truncate pr-8">{p.name}</SheetTitle>
            <SheetDescription>{format(d.projectSummary, { running, total: members.length })}</SheetDescription>
          </SheetHeader>
          <div className="grid gap-5 overflow-y-auto px-4 pb-4">
            <Button size="sm" variant="outline" className="w-fit" onClick={() => onShowProject(p.name)}>
              {d.showOnlyProject}
            </Button>
            <Section title={d.overview}>
              {p.workingDir ? (
                <Field label={d.directory}>
                  <Mono className="break-all">{p.workingDir}</Mono>
                </Field>
              ) : null}
              {p.configFiles.length ? (
                <Field label={d.composeFiles}>
                  <span className="grid gap-0.5">
                    {p.configFiles.map((f) => (
                      <Mono key={f} className="break-all">
                        {f}
                      </Mono>
                    ))}
                  </span>
                </Field>
              ) : null}
            </Section>
            <Section title={format(d.containers, { count: members.length })}>
              <ul className="grid gap-1.5">
                {members.map((c) => (
                  <ContainerRef key={c.id} c={c} extra={c.service} />
                ))}
              </ul>
            </Section>
          </div>
        </>
      )
    }
  }
}
