import type { Metadata } from "next"
import Link from "next/link"
import { PlusIcon } from "lucide-react"

import { TemplatesGallery } from "@/components/gantry/templates-gallery"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader, WrongEnvironmentKind } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getPermissions } from "@/lib/server/environments"
import { listTemplates } from "@/lib/server/templates"
import { validateCompose } from "@/lib/stacks"

export const metadata: Metadata = { title: "Templates" }

export default async function TemplatesPage() {
  const user = await requireUser()
  const [templates, env, can] = await Promise.all([listTemplates(), getCurrentEnvironment(), getPermissions()])

  return (
    <PageBody>
      <PageHeader
        title="Templates"
        description={
          can.manage
            ? "Ready-made compose stacks. Pick one, fill in a few values and it is deployed as a stack you can edit later."
            : "Ready-made compose stacks. Deploying one needs the manager role in this environment."
        }
        actions={
          user.role === "admin" ? (
            <Button size="sm" asChild>
              <Link href="/templates/new">
                <PlusIcon data-icon="inline-start" />
                New template
              </Link>
            </Button>
          ) : null
        }
      />
      {/* Templates deploy Docker Compose stacks; they can still be browsed and edited. */}
      {env?.type === "kubernetes" ? <WrongEnvironmentKind kind="kubernetes" /> : null}
      <TemplatesGallery
        templates={templates.map((t) => {
          const check = validateCompose(t.compose)
          return {
            key: t.key,
            title: t.title,
            description: t.description,
            category: t.category,
            source: t.source,
            services: check.ok ? check.services : [],
          }
        })}
      />
    </PageBody>
  )
}
