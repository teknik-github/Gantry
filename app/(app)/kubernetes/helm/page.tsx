import type { Metadata } from "next"

import { HelmReleasesTable } from "@/components/gantry/kubernetes/helm"
import { KubeUnavailable, loadKubePage, NamespaceFilter } from "@/components/gantry/kubernetes/page"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { tryKube } from "@/lib/server/kubernetes"
import { listReleases } from "@/lib/server/kubernetes/helm"

export const metadata: Metadata = { title: "Helm releases" }

export default async function HelmPage() {
  const { page, blocked } = await loadKubePage()
  const header = (
    <PageHeader
      title="Helm releases"
      description="Releases installed with Helm 3 (read from their release records in the cluster)."
      actions={page ? <NamespaceFilter page={page} /> : null}
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
          isAdmin={page.user.role === "admin"}
          showNamespace={!page.namespace}
        />
      )}
    </PageBody>
  )
}
