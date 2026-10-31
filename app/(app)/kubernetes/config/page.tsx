import type { Metadata } from "next"

import { KubeUnavailable, loadKubePage, NamespaceFilter } from "@/components/gantry/kubernetes/page"
import { ConfigMapsTable, SecretsTable } from "@/components/gantry/kubernetes/tables"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { toConfigMapRows, toSecretRows } from "@/lib/kubernetes/rows"
import { tryKube } from "@/lib/server/kubernetes"

export const metadata: Metadata = { title: "ConfigMaps & Secrets" }

// Names and keys only: Secret values are dropped on the server
// (KubeApi.listSecrets) and never reach the browser.
export default async function ConfigPage() {
  const { page, blocked } = await loadKubePage()
  const header = (
    <PageHeader
      title="ConfigMaps"
      description="Names and keys only."
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

  const [configMaps, secrets] = await Promise.all([
    tryKube(async () => toConfigMapRows(await page.api.listConfigMaps(page.namespace))),
    tryKube(async () => toSecretRows(await page.api.listSecrets(page.namespace))),
  ])
  const showNamespace = !page.namespace

  return (
    <PageBody>
      {header}
      {configMaps.error !== undefined ? (
        <KubeUnavailable message={configMaps.error} />
      ) : (
        <ConfigMapsTable data={configMaps.data} showNamespace={showNamespace} canEdit={page.can.manage} />
      )}
      <PageHeader title="Secrets" description="Lists show key names only; values are shown to administrators in Edit YAML." />
      {secrets.error !== undefined ? (
        <KubeUnavailable message={secrets.error} />
      ) : (
        <SecretsTable data={secrets.data} showNamespace={showNamespace} canEdit={page.can.manage && page.user.role === "admin"} />
      )}
    </PageBody>
  )
}
