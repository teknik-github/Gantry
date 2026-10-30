import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react"

import { TemplateAdminActions } from "@/components/gantry/template-admin-actions"
import { TemplateDeployForm } from "@/components/gantry/template-deploy-form"
import { DockerUnavailable, PageBody } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireUser } from "@/lib/server/auth/dal"
import { KUBERNETES_ENVIRONMENT } from "@/lib/messages"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { getTemplate } from "@/lib/server/templates"

export async function generateMetadata({ params }: PageProps<"/templates/[key]">): Promise<Metadata> {
  const template = await getTemplate((await params).key)
  return { title: template ? `${template.title} template` : "Template" }
}

export default async function TemplatePage({ params }: PageProps<"/templates/[key]">) {
  const user = await requireUser()
  const template = await getTemplate((await params).key)
  if (!template) notFound()
  const isAdmin = user.role === "admin"
  const env = await getCurrentEnvironment()

  return (
    <PageBody>
      <div className="flex flex-wrap items-end justify-between gap-3 px-4 lg:px-6">
        <div className="grid gap-1">
          <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
            <Link href="/templates">
              <ArrowLeftIcon data-icon="inline-start" />
              Templates
            </Link>
          </Button>
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {template.title}
            <Badge variant="outline">{template.category}</Badge>
            {template.source === "custom" ? <Badge variant="secondary">custom</Badge> : null}
          </h2>
          <p className="text-sm text-muted-foreground">
            {template.description || "No description"}
            {template.website ? (
              <>
                {" "}
                <a
                  href={template.website}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 underline underline-offset-4"
                >
                  Website
                  <ExternalLinkIcon className="size-3" />
                </a>
              </>
            ) : null}
          </p>
        </div>
        {isAdmin && template.source === "custom" ? <TemplateAdminActions templateKey={template.key} title={template.title} /> : null}
      </div>

      <div className="grid gap-4 px-4 lg:px-6 @5xl/main:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {isAdmin ? (
          env && env.type !== "kubernetes" ? (
            <Card>
              <CardHeader>
                <CardTitle>Deploy</CardTitle>
                <CardDescription>
                  Creates a stack on <span className="font-medium text-foreground">{env.name}</span> and runs{" "}
                  <code>docker compose up -d</code>.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TemplateDeployForm templateKey={template.key} stackName={template.stackName} variables={template.variables} />
              </CardContent>
            </Card>
          ) : (
            <DockerUnavailable message={env ? KUBERNETES_ENVIRONMENT : "No Docker environment configured"} />
          )
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Deploy</CardTitle>
              <CardDescription>Only administrators can deploy templates.</CardDescription>
            </CardHeader>
          </Card>
        )}
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Compose file</CardTitle>
            <CardDescription>
              {"${VARIABLES}"} are filled in from the stack&apos;s .env.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre
              className="max-h-[70vh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed"
              data-testid="template-compose"
            >
              {template.compose}
            </pre>
          </CardContent>
        </Card>
      </div>
    </PageBody>
  )
}
