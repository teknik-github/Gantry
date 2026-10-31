import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { HelmReposTable } from "@/components/gantry/kubernetes/helm-repos"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { Button } from "@/components/ui/button"
import { requireAdmin } from "@/lib/server/auth/dal"
import { listHelmRepos } from "@/lib/server/kubernetes/helm-repos"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.kubernetes.helm.chartRepositories }
}

// Global, like registry logins: administrators manage them, managers of a
// cluster install from them.
export default async function ChartRepositoriesPage() {
  await requireAdmin()
  const { t, timeAgo } = await getI18n()
  const repos = await listHelmRepos()
  return (
    <PageBody>
      <PageHeader
        title={t.kubernetes.helm.chartRepositories}
        description={t.kubernetes.repos.description}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/kubernetes/charts">
              <ArrowLeftIcon data-icon="inline-start" />
              {t.kubernetes.repos.installChart}
            </Link>
          </Button>
        }
      />
      <HelmReposTable data={repos.map((r) => ({ ...r, updatedLabel: timeAgo(r.updatedAt) }))} />
    </PageBody>
  )
}
