// Pure helpers of the container page (app/(app)/containers/[id]/page.tsx).

import type { ProxyHost } from "@/lib/proxy"

/** "[ip:]hostPort → containerPort/proto", one line per published binding. */
export function portBindingLines(
  bindings: Record<string, { HostIp: string; HostPort: string }[] | null> | null | undefined
): string[] {
  return Object.entries(bindings ?? {}).flatMap(([container, binds]) =>
    (binds ?? []).map((b) => `${b.HostIp ? `${b.HostIp}:` : ""}${b.HostPort} → ${container}`)
  )
}

/** Port numbers of the image's EXPOSE ("80/tcp" and "80/udp" are one). */
export function exposedPortNumbers(exposed: Record<string, unknown> | null | undefined): number[] {
  return [...new Set(Object.keys(exposed ?? {}).map((p) => Number(p.split("/")[0])))].filter(Boolean)
}

/** Link to a proxied domain; a wildcard opens its www. host. */
export function proxyDomainUrl(host: Pick<ProxyHost, "tls">, domain: string): string {
  return `${host.tls === "off" ? "http" : "https"}://${domain.replace(/^\*\./, "www.")}`
}

/** KEY=value of the container's environment (the value may contain "="). */
export function splitEnvEntry(entry: string): { key: string; value: string } {
  const [key, ...rest] = entry.split("=")
  return { key, value: rest.join("=") }
}

/** Entrypoint and command as one line, "—" when there is none. */
export function commandLine(entrypoint: string[] | null | undefined, cmd: string[] | null | undefined): string {
  return [...(entrypoint ?? []), ...(cmd ?? [])].join(" ") || "—"
}

export type ContainerTab = "logs" | "files" | "console"

/** The tab ?tab= opens: the console only for managers, else the logs. */
export function initialContainerTab(tab: string | string[] | undefined, canManage: boolean): ContainerTab {
  return tab === "console" && canManage ? "console" : tab === "files" ? "files" : "logs"
}
