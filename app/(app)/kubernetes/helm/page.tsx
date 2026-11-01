import type { Metadata } from "next"
import Link from "next/link"
import { LibraryIcon, PackagePlusIcon } from "lucide-react"

import { HelmReleasesTable } from "@/components/gantry/kubernetes/helm"
import { KubeUnavailable, loadKubePage, NamespaceFilter } from "@/components/gantry/kubernetes/page"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { Button } from "@/components/ui/button"
import { tryKube } from "@/lib/server/kubernetes"
import { listReleases } from "@/lib/server/kubernetes/helm"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.helm }
}

export default async function HelmPage() {
  const { t } = await getI18n()
  const { page, blocked } = await loadKubePage()
  const header = (
    <PageHeader
      title={t.nav.pages.helm}
      description={t.kubernetes.helm.description}
      actions={
        page ? (
          <>
            {page.user.role === "admin" ? (
              <Button variant="outline" size="sm" asChild>
                <Link href="/kubernetes/charts/repositories">
                  <LibraryIcon data-icon="inline-start" />
                  {t.kubernetes.helm.chartRepositories}
                </Link>
              </Button>
            ) : null}
            {page.can.manage ? (
              <Button size="sm" asChild>
                <Link href="/kubernetes/charts">
                  <PackagePlusIcon data-icon="inline-start" />
                  {t.kubernetes.helm.installChart}
                </Link>
              </Button>
            ) : null}
            <NamespaceFilter page={page} />
          </>
        ) : null
      }
    />
  )
  if (!page) {
    return (
      <PageBody>
        {header}
        {blocked}
      </PageBody>
    )
  }

  const result = await tryKube(() => listReleases(page.api, page.namespace))

  return (
    <PageBody>
      {header}
      {result.error !== undefined ? (
        <KubeUnavailable message={result.error} />
      ) : (
        <HelmReleasesTable
          data={result.data}
          environmentId={page.env.id}
          canManage={page.can.manage}
          showNamespace={!page.namespace}
        />
      )}
    </PageBody>
  )
}
