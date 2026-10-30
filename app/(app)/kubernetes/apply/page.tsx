import type { Metadata } from "next"

import { ApplyForm } from "@/components/gantry/kubernetes/apply-form"
import { loadKubePage } from "@/components/gantry/kubernetes/page"
import { PageBody, PageHeader } from "@/components/gantry/ui"

export const metadata: Metadata = { title: "Apply manifest" }

export default async function ApplyPage() {
  const { page, blocked } = await loadKubePage()
  const header = (
    <PageHeader
      title="Apply manifest"
      description="Create or update objects from YAML with server-side apply."
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
  if (page.user.role !== "admin") {
    return (
      <PageBody>
        {header}
        <p className="px-4 text-sm text-muted-foreground lg:px-6">Only administrators can apply manifests.</p>
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
