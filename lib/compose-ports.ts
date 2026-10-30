import { isMap, isScalar, isSeq, parseDocument } from "yaml"

// Which container ports a compose file's services publish, for pointing a
// proxy host at a freshly deployed template. Pure.

export type ServicePort = { service: string; port: number }

/** Container side of a short-syntax port ("8080:80", "127.0.0.1:8080:80/tcp", "80"). */
function containerPort(entry: string): number | null {
  const spec = entry.split("/")[0].trim()
  const last = spec.split(":").at(-1) ?? ""
  // Ranges ("8000-8010") and ${VARIABLES} on the container side are skipped.
  return /^\d{1,5}$/.test(last) && Number(last) <= 65535 && Number(last) > 0 ? Number(last) : null
}

export function composeServicePorts(compose: string): ServicePort[] {
  const doc = parseDocument(compose)
  const services = doc.get("services", true)
  if (!isMap(services)) return []
  const out: ServicePort[] = []
  for (const item of services.items) {
    const service = String((item.key as { value?: unknown })?.value ?? item.key)
    if (!isMap(item.value)) continue
    const ports = item.value.get("ports", true)
    if (!isSeq(ports)) continue
    for (const p of ports.items) {
      let port: number | null = null
      if (isScalar(p)) port = containerPort(String(p.value))
      else if (isMap(p)) {
        const target = Number(p.get("target"))
        port = Number.isInteger(target) && target > 0 && target <= 65535 ? target : null
      }
      if (port && !out.some((o) => o.service === service && o.port === port)) out.push({ service, port })
    }
  }
  return out
}

/** Docker Compose's default container name for the first replica of a service. */
export function composeContainerName(project: string, service: string) {
  return `${project}-${service}-1`
}
