import type { Metadata } from "next"

import { KubeUnavailable, loadKubePage, NamespaceFilter } from "@/components/gantry/kubernetes/page"
import { PodsTable } from "@/components/gantry/kubernetes/tables"
import { PageBody, PageHeader } from "@/components/gantry/ui"
import { toPodRows } from "@/lib/kubernetes/rows"
import { tryKube } from "@/lib/server/kubernetes"

export const metadata: Metadata = { title: "Pods" }

export default async function PodsPage() {
  const { page, blocked } = await loadKubePage()
  const header = <PageHeader title="Pods" actions={page ? <NamespaceFilter page={page} /> : null} />
  if (!page) {
    return (
      <PageBody>
        {header}
        {blocked}
      </PageBody>
    )
  }

  const result = await tryKube(async () =>
    toPodRows(await page.api.listPods(page.namespace)).sort(
      (a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name)
    )
  )

  return (
    <PageBody>
      {header}
      {result.error !== undefined ? (
        <KubeUnavailable message={result.error} />
      ) : (
        <PodsTable
          data={result.data}
          environmentId={page.env.id}
          isAdmin={page.user.role === "admin"}
          showNamespace={!page.namespace}
        />
      )}
    </PageBody>
  )
}
