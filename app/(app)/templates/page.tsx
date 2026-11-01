import type { Metadata } from "next"
import Link from "next/link"
import { PlusIcon } from "lucide-react"

import { TemplatesGallery } from "@/components/gantry/templates-gallery"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader, WrongEnvironmentKind } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { getI18n } from "@/lib/i18n/server"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getPermissions } from "@/lib/server/environments"
import { listTemplates } from "@/lib/server/templates"
import { validateCompose } from "@/lib/stacks"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.nav.pages.templates }
}

export default async function TemplatesPage() {
  const user = await requireUser()
  const { t: messages } = await getI18n()
  const [templates, env, can] = await Promise.all([listTemplates(), getCurrentEnvironment(), getPermissions()])

  return (
    <PageBody>
      <PageHeader
        title={messages.nav.pages.templates}
        description={can.manage ? messages.templates.list.descriptionManage : messages.templates.list.descriptionView}
        actions={
          user.role === "admin" ? (
            <Button size="sm" asChild>
              <Link href="/templates/new">
                <PlusIcon data-icon="inline-start" />
                {messages.templates.list.newTemplate}
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
