import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon } from "lucide-react"

import { TemplateEditor } from "@/components/gantry/template-editor"
import { PageBody } from "@/components/gantry/page-body"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { getI18n } from "@/lib/i18n/server"
import { requireAdmin } from "@/lib/server/auth/dal"
import { getCustomTemplate } from "@/lib/server/templates"
import { customTemplateId } from "@/lib/templates"

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getI18n()).t.templates.editor.editTitle }
}

export default async function EditTemplatePage({ params }: PageProps<"/templates/[key]/edit">) {
  await requireAdmin()
  const { t } = await getI18n()
  const { key } = await params
  const id = customTemplateId(key)
  // Built-in templates can't be edited; save a stack deployed from one as a template instead.
  const template = id === null ? null : await getCustomTemplate(id)
  if (!template) notFound()

  return (
    <PageBody>
      <div className="grid gap-1 px-4 lg:px-6">
        <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
          <Link href={`/templates/${key}`}>
            <ArrowLeftIcon data-icon="inline-start" />
            {template.title}
          </Link>
        </Button>
        <h2 className="text-xl font-semibold tracking-tight">{t.templates.editor.editTitle}</h2>
      </div>
      <div className="px-4 lg:px-6">
        <Card>
          <CardContent>
            <TemplateEditor
              templateKey={key}
              initial={{
                title: template.title,
                description: template.description,
                category: template.category,
                stack_name: template.stackName,
                compose: template.compose,
                env: template.env,
              }}
            />
          </CardContent>
        </Card>
      </div>
    </PageBody>
  )
}
