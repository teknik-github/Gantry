import type { Metadata } from "next"

import { KubeUnavailable, loadKubePage, NamespaceFilter } from "@/components/gantry/kubernetes/page"
import { WorkloadsTable } from "@/components/gantry/kubernetes/tables"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { WORKLOAD_KINDS } from "@/lib/kubernetes/names"
import { toWorkloadRows } from "@/lib/kubernetes/rows"
import { tryKube } from "@/lib/server/kubernetes"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.workloads }
}

export default async function WorkloadsPage() {
  const { t } = await getI18n()
  const { page, blocked } = await loadKubePage()
  const header = (
    <PageHeader
      title={t.nav.pages.workloads}
      description={t.kubernetes.workloads.description}
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

  const result = await tryKube(async () => {
    const lists = await Promise.all(WORKLOAD_KINDS.map(async (kind) => toWorkloadRows(kind, await page.api.listWorkloads(kind, page.namespace))))
    return lists.flat().sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
  })

  return (
    <PageBody>
      {header}
      {result.error !== undefined ? (
        <KubeUnavailable message={result.error} />
      ) : (
        <WorkloadsTable
          data={result.data}
          environmentId={page.env.id}
          canOperate={page.can.operate}
          canManage={page.can.manage}
          showNamespace={!page.namespace}
        />
      )}
    </PageBody>
  )
}
