import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { TemplateEditor } from "@/components/gantry/template-editor"
import { PageBody } from "@/components/gantry/page-body"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { getI18n } from "@/lib/i18n/server"
import { requireAdmin } from "@/lib/server/auth/dal"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.templates.editor.newTitle }
}

export default async function NewTemplatePage() {
  await requireAdmin()
  const { t } = await getI18n()
  return (
    <PageBody>
      <div className="grid gap-1 px-4 lg:px-6">
        <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
          <Link href="/templates">
            <ArrowLeftIcon data-icon="inline-start" />
            {t.nav.pages.templates}
          </Link>
        </Button>
        <h2 className="text-xl font-semibold tracking-tight">{t.templates.editor.newTitle}</h2>
        <p className="text-sm text-muted-foreground">{t.templates.editor.newDescription}</p>
      </div>
      <div className="px-4 lg:px-6">
        <Card>
          <CardContent>
            <TemplateEditor />
          </CardContent>
        </Card>
      </div>
    </PageBody>
  )
}
