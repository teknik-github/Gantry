import type { Metadata } from "next"

import { ApplyForm } from "@/components/gantry/kubernetes/apply-form"
import { loadKubePage } from "@/components/gantry/kubernetes/page"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.apply }
}

export default async function ApplyPage() {
  const { t } = await getI18n()
  const { page, blocked } = await loadKubePage()
  const header = (
    <PageHeader
      title={t.nav.pages.apply}
      description={t.kubernetes.apply.description}
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
  if (!page.can.manage) {
    return (
      <PageBody>
        {header}
        <p className="px-4 text-sm text-muted-foreground lg:px-6">{t.kubernetes.common.managerOnlyApply}</p>
      </PageBody>
    )
  }

  const namespaces = await page.api.listNamespaces().then(
    (list) => list.map((n) => n.metadata.name).sort(),
    () => []
  )
  const defaultNamespace = page.namespace ?? page.env.kube_namespace ?? "default"

  return (
    <PageBody>
      {header}
      <ApplyForm environmentId={page.env.id} namespaces={namespaces} defaultNamespace={defaultNamespace} />
    </PageBody>
  )
}
