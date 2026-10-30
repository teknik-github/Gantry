import type { Metadata } from "next"

import { EnvironmentsTable, type EnvironmentRow } from "@/components/gantry/admin-tables"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { requireAdmin } from "@/lib/server/auth/dal"
import { getDb } from "@/lib/server/db"
import { docker } from "@/lib/server/docker/api"
import { listGrants } from "@/lib/server/environment-access"
import { hasTls } from "@/lib/server/environment-target"
import { environmentTarget, getCurrentEnvironment, listEnvironments } from "@/lib/server/environments"
import { kube } from "@/lib/server/kubernetes/api"
import { credentialSummary, kubeTarget } from "@/lib/server/kubernetes/target"

export const metadata: Metadata = { title: "Environments" }

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

  return (
    <PageBody>
      <PageHeader
        title="Environments"
        description="Docker hosts and Kubernetes clusters managed by Gantry. Administrators can use all of them; standard users only those they were given access to, as viewer, operator or manager."
      />
      <EnvironmentsTable data={rows} users={users.map(({ id, username }) => ({ id, username }))} />
    </PageBody>
  )
}
