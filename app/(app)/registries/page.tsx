import type { Metadata } from "next"

import { RegistriesTable } from "@/components/gantry/registries-table"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { timeAgo } from "@/lib/format"
import { requireAdmin } from "@/lib/server/auth/dal"
import { listRegistries } from "@/lib/server/registries"

export const metadata: Metadata = { title: "Registries" }

export default async function RegistriesPage() {
  await requireAdmin()
  const registries = await listRegistries()

  return (
    <PageBody>
      <PageHeader
        title="Registries"
        description="Logins for private registries. Gantry uses them for pulls, update checks, recreate and stacks on every Docker environment (Kubernetes clusters use their own image pull secrets)."
      />
      <RegistriesTable
        data={registries.map((r) => ({ ...r, updatedLabel: timeAgo(r.updatedAt) }))}
      />
    </PageBody>
  )
}
