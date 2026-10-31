import type { Metadata } from "next"

import { KubeUnavailable, loadKubePage, NamespaceFilter } from "@/components/gantry/kubernetes/page"
import { EventsTable } from "@/components/gantry/kubernetes/tables"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { toEventRows } from "@/lib/kubernetes/rows"
import { tryKube } from "@/lib/server/kubernetes"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.events }
}

const MAX_EVENTS = 500

export default async function EventsPage() {
  const { t } = await getI18n()
  const { page, blocked } = await loadKubePage()
  const header = (
    <PageHeader
      title={t.nav.pages.events}
      description={t.kubernetes.events.description}
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

  const result = await tryKube(async () => toEventRows(await page.api.listEvents(page.namespace, "Warning")).slice(0, MAX_EVENTS))

  return (
    <PageBody>
      {header}
      {result.error !== undefined ? (
        <KubeUnavailable message={result.error} />
      ) : (
        <EventsTable data={result.data} showNamespace={!page.namespace} />
      )}
    </PageBody>
  )
}
