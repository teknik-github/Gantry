import type { Metadata } from "next"
import Link from "next/link"
import { LibraryIcon } from "lucide-react"

import { HelmInstallForm } from "@/components/gantry/kubernetes/helm-forms"
import { KubeUnavailable, loadKubePage } from "@/components/gantry/kubernetes/page"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { HELM_MISSING, helmVersion } from "@/lib/server/kubernetes/helm-cli"
import { listHelmRepos } from "@/lib/server/kubernetes/helm-repos"

export const metadata: Metadata = { title: "Install a Helm chart" }

export default async function ChartsPage() {
  const { page, blocked } = await loadKubePage()
  const reposLink = (
    <Button variant="outline" size="sm" asChild>
      <Link href="/kubernetes/charts/repositories">
        <LibraryIcon data-icon="inline-start" />
        Chart repositories
      </Link>
    </Button>
  )
  const header = (
    <PageHeader
      title="Install a Helm chart"
      description="Install a chart from a repository or an OCI registry with helm install."
      actions={page?.user.role === "admin" ? reposLink : null}
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
        <p className="px-4 text-sm text-muted-foreground lg:px-6">Installing charts needs the manager role in this environment.</p>
      </PageBody>
    )
  }

  const [version, repos, namespaces] = await Promise.all([
    helmVersion(),
    listHelmRepos(),
    page.api.listNamespaces().then(
      (list) => list.map((n) => n.metadata.name).sort(),
      () => []
    ),
  ])
  if (!version) {
    return (
      <PageBody>
        {header}
        <KubeUnavailable message={HELM_MISSING} />
      </PageBody>
    )
  }

  return (
    <PageBody>
      {header}
      <HelmInstallForm
        environmentId={page.env.id}
        repos={repos.map((r) => ({ id: r.id, name: r.name, url: r.url, oci: r.oci }))}
        namespaces={namespaces}
        defaultNamespace={page.namespace ?? page.env.kube_namespace ?? "default"}
      />
    </PageBody>
  )
}
