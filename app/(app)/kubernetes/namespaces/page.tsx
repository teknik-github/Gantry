import type { Metadata } from "next"

import { KubeUnavailable, loadKubePage } from "@/components/gantry/kubernetes/page"
import { NamespacesTable } from "@/components/gantry/kubernetes/tables"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { toNamespaceRows } from "@/lib/kubernetes/rows"
import { tryKube } from "@/lib/server/kubernetes"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.namespaces }
}

export default async function NamespacesPage() {
  const { t } = await getI18n()
  const { page, blocked } = await loadKubePage()
  const header = <PageHeader title={t.nav.pages.namespaces} />
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
