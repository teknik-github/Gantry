import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { TemplateEditor } from "@/components/gantry/template-editor"
import { PageBody } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { requireAdmin } from "@/lib/server/auth/dal"

export const metadata: Metadata = { title: "New template" }

export default async function NewTemplatePage() {
  await requireAdmin()
  return (
    <PageBody>
      <div className="grid gap-1 px-4 lg:px-6">
        <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
          <Link href="/templates">
            <ArrowLeftIcon data-icon="inline-start" />
            Templates
          </Link>
        </Button>
        <h2 className="text-xl font-semibold tracking-tight">New template</h2>
        <p className="text-sm text-muted-foreground">
          Your own docker compose file, reusable on any environment. Tip: an existing stack can be saved as a template
          from its page.
        </p>
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
