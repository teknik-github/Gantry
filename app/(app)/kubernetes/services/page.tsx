import type { Metadata } from "next"

import { KubeUnavailable, loadKubePage, NamespaceFilter } from "@/components/gantry/kubernetes/page"
import { IngressesTable, ServicesTable } from "@/components/gantry/kubernetes/tables"
import { PageBody, PageHeader } from "@/components/gantry/ui"
import { toIngressRows, toServiceRows } from "@/lib/kubernetes/rows"
import { tryKube } from "@/lib/server/kubernetes"

export const metadata: Metadata = { title: "Services" }

export default async function ServicesPage() {
  const { page, blocked } = await loadKubePage()
  const header = <PageHeader title="Services" actions={page ? <NamespaceFilter page={page} /> : null} />
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
        <ServicesTable data={services.data} showNamespace={showNamespace} />
      )}
      <PageHeader title="Ingresses" />
      {ingresses.error !== undefined ? (
        <KubeUnavailable message={ingresses.error} />
      ) : (
        <IngressesTable data={ingresses.data} showNamespace={showNamespace} />
      )}
    </PageBody>
  )
}
