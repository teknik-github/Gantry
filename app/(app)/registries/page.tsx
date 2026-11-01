import type { Metadata } from "next"

import { RegistriesTable } from "@/components/gantry/registries-table"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { getI18n } from "@/lib/i18n/server"
import { requireAdmin } from "@/lib/server/auth/dal"
import { listRegistries } from "@/lib/server/registries"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.registries }
}

export default async function RegistriesPage() {
  await requireAdmin()
  const registries = await listRegistries()
  const { t, timeAgo } = await getI18n()

  return (
    <PageBody>
      <PageHeader
        title={t.nav.pages.registries}
        description={t.registries.description}
      />
      <RegistriesTable
        data={registries.map((r) => ({ ...r, updatedLabel: timeAgo(r.updatedAt) }))}
      />
    </PageBody>
  )
}
