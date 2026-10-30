import type { Metadata } from "next"

import { KubeUnavailable, loadKubePage } from "@/components/gantry/kubernetes/page"
import { NamespacesTable } from "@/components/gantry/kubernetes/tables"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { toNamespaceRows } from "@/lib/kubernetes/rows"
import { tryKube } from "@/lib/server/kubernetes"

export const metadata: Metadata = { title: "Namespaces" }

export default async function NamespacesPage() {
  const { page, blocked } = await loadKubePage()
  const header = <PageHeader title="Namespaces" />
  if (!page) {
    return (
      <PageBody>
        {header}
        {blocked}
      </PageBody>
    )
  }

  const result = await tryKube(async () =>
    toNamespaceRows(await page.api.listNamespaces()).sort((a, b) => a.name.localeCompare(b.name))
  )

  return (
    <PageBody>
      {header}
      {result.error !== undefined ? (
        <KubeUnavailable message={result.error} />
      ) : (
        <NamespacesTable data={result.data} environmentId={page.env.id} canManage={page.can.manage} />
      )}
    </PageBody>
  )
}
