import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { HelmReposTable } from "@/components/gantry/kubernetes/helm-repos"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { timeAgo } from "@/lib/format"
import { requireAdmin } from "@/lib/server/auth/dal"
import { listHelmRepos } from "@/lib/server/kubernetes/helm-repos"

export const metadata: Metadata = { title: "Chart repositories" }

// Global, like registry logins: administrators manage them, managers of a
// cluster install from them.
export default async function ChartRepositoriesPage() {
  await requireAdmin()
  const repos = await listHelmRepos()
  return (
    <PageBody>
      <PageHeader
        title="Chart repositories"
        description="Helm chart repositories and OCI registries to install charts from, on every Kubernetes environment."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/kubernetes/charts">
              <ArrowLeftIcon data-icon="inline-start" />
              Install a chart
            </Link>
          </Button>
        }
      />
      <HelmReposTable data={repos.map((r) => ({ ...r, updatedLabel: timeAgo(r.updatedAt) }))} />
    </PageBody>
  )
}
