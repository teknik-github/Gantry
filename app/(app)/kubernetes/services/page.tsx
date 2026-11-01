import type { Metadata } from "next"

import { KubeUnavailable, loadKubePage, NamespaceFilter } from "@/components/gantry/kubernetes/page"
import { IngressesTable, ServicesTable } from "@/components/gantry/kubernetes/tables"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { toIngressRows, toServiceRows } from "@/lib/kubernetes/rows"
import { tryKube } from "@/lib/server/kubernetes"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.services }
}

export default async function ServicesPage() {
  const { t } = await getI18n()
  const { page, blocked } = await loadKubePage()
  const header = <PageHeader title={t.nav.pages.services} actions={page ? <NamespaceFilter page={page} /> : null} />
  if (!page) {
    return (
      <PageBody>
        {header}
        {blocked}
      </PageBody>
    )
  }

  const [services, ingresses] = await Promise.all([
    tryKube(async () => toServiceRows(await page.api.listServices(page.namespace))),
    tryKube(async () => toIngressRows(await page.api.listIngresses(page.namespace))),
  ])
  const showNamespace = !page.namespace

  return (
    <PageBody>
      {header}
      {services.error !== undefined ? (
        <KubeUnavailable message={services.error} />
      ) : (
        <ServicesTable data={services.data} showNamespace={showNamespace} canEdit={page.can.manage} />
      )}
      <PageHeader title={t.kubernetes.services.ingresses} />
      {ingresses.error !== undefined ? (
        <KubeUnavailable message={ingresses.error} />
      ) : (
        <IngressesTable data={ingresses.data} showNamespace={showNamespace} canEdit={page.can.manage} />
      )}
    </PageBody>
  )
}
