import type { Metadata } from "next"

import { EnvironmentsTable, type EnvironmentRow } from "@/components/gantry/admin-tables"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { agentStatus } from "@/lib/server/agent/hub"
import { readStoredInfo } from "@/lib/server/agent/info"
import { requireAdmin } from "@/lib/server/auth/dal"
import { getDb } from "@/lib/server/db"
import { docker } from "@/lib/server/docker/api"
import { listGrants } from "@/lib/server/environment-access"
import { hasTls } from "@/lib/server/environment-target"
import { environmentTarget, getCurrentEnvironment, listEnvironments } from "@/lib/server/environments"
import { kube } from "@/lib/server/kubernetes/api"
import { credentialSummary, kubeTarget } from "@/lib/server/kubernetes/target"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.environments }
}

export default async function EnvironmentsPage() {
  await requireAdmin()
  const db = await getDb()
  const [envs, current, grants, users] = await Promise.all([
    listEnvironments(),
    getCurrentEnvironment(),
    listGrants(db),
    db.selectFrom("users").select(["id", "username"]).where("role", "=", "user").orderBy("username").execute(),
  ])

  const rows: EnvironmentRow[] = await Promise.all(
    envs.map(async (e) => {
      const base = {
        id: e.id,
        name: e.name,
        type: e.type,
        url: e.url,
        // Only whether TLS is configured; the PEM material never leaves the server.
        tls: hasTls(e),
        // Kubernetes: which kinds of credentials are stored (names only) and the plain settings.
        kubeAuth: credentialSummary(e),
        kubeInsecure: e.type === "kubernetes" && Boolean(e.kube_insecure),
        kubeNamespace: e.kube_namespace,
        current: e.id === current?.id,
        agent: e.type === "agent" ? agentRow(e) : null,
        access: grants
          .filter((g) => g.environment_id === e.id)
          .map((g) => ({ id: g.user_id, username: g.username, role: g.role })),
      }
      try {
        if (e.type === "kubernetes") {
          const api = kube(kubeTarget(e))
          const [version] = await Promise.all([api.version(), api.checkAccess()])
          return { ...base, status: "up" as const, version: `Kubernetes ${version.gitVersion}`, error: null }
        }
        const info = await docker(environmentTarget(e)).info()
        return { ...base, status: "up" as const, version: `Docker ${info.ServerVersion}`, error: null }
      } catch (err) {
        return { ...base, status: "down" as const, version: null, error: (err as Error).message }
      }
    })
  )

  const { t } = await getI18n()
  return (
    <PageBody>
      <PageHeader title={t.nav.pages.environments} description={t.environments.description} />
      <EnvironmentsTable data={rows} users={users.map(({ id, username }) => ({ id, username }))} />
    </PageBody>
  )
}

/** Agent environments: the live session (this process) or what the agent last reported. */
function agentRow(e: Awaited<ReturnType<typeof listEnvironments>>[number]): NonNullable<EnvironmentRow["agent"]> {
  const live = agentStatus(e.id)
  const stored = readStoredInfo(e.agent_info)
  const info = live.info ?? stored
  return {
    connected: live.connected,
    since: live.connectedAt,
    lastSeen: e.agent_seen_at,
    version: info?.version ?? null,
    hostname: info?.hostname ?? null,
    dockerVersion: info?.dockerVersion || null,
    remoteAddress: live.connected ? live.remoteAddress : (stored?.remoteAddress ?? null),
    rttMs: live.rttMs,
    keyCreatedAt: e.agent_key_created_at,
  }
}
