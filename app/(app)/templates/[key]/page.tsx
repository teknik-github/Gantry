import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon, ExternalLinkIcon } from "lucide-react"

import { TemplateAdminActions } from "@/components/gantry/template-admin-actions"
import { TemplateDeployForm } from "@/components/gantry/template-deploy-form"
import { PageBody } from "@/components/gantry/page-body"
import { DockerUnavailable } from "@/components/gantry/ui"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getI18n } from "@/lib/i18n/server"
import { requireUser } from "@/lib/server/auth/dal"
import { KUBERNETES_ENVIRONMENT } from "@/lib/messages"
import { getCurrentEnvironment, getPermissions } from "@/lib/server/environments"
import { getTemplate } from "@/lib/server/templates"
import { composeServicePorts } from "@/lib/compose-ports"
import { getProxySettings } from "@/lib/server/proxy"

export async function generateMetadata({ params }: PageProps<"/templates/[key]">): Promise<Metadata> {
  const template = await getTemplate((await params).key)
  const { t, format } = await getI18n()
  return { title: template ? format(t.templates.detail.pageTitle, { title: template.title }) : t.templates.detail.template }
}

export default async function TemplatePage({ params }: PageProps<"/templates/[key]">) {
  const user = await requireUser()
  const { t, rich } = await getI18n()
  const text = t.templates.detail
  const template = await getTemplate((await params).key)
  if (!template) notFound()
  const isAdmin = user.role === "admin"
  const env = await getCurrentEnvironment()
  const proxyMode = env ? (await getProxySettings(env.id)).settings.mode : "off"
  // Deploying creates a stack in the current environment; editing templates is global.
  const canDeploy = (await getPermissions()).manage

  return (
    <PageBody>
      <div className="flex flex-wrap items-end justify-between gap-3 px-4 lg:px-6">
        <div className="grid gap-1">
          <Button asChild variant="link" size="sm" className="h-auto w-fit p-0 text-muted-foreground">
            <Link href="/templates">
              <ArrowLeftIcon data-icon="inline-start" />
              {t.nav.pages.templates}
            </Link>
          </Button>
          <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {template.title}
            <Badge variant="outline">{template.category}</Badge>
            {template.source === "custom" ? <Badge variant="secondary">{t.templates.gallery.customBadge}</Badge> : null}
          </h2>
          <p className="text-sm text-muted-foreground">
            {template.description || t.templates.gallery.noDescription}
            {template.website ? (
              <>
                {" "}
                <a
                  href={template.website}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 underline underline-offset-4"
                >
                  {text.website}
                  <ExternalLinkIcon className="size-3" />
                </a>
              </>
            ) : null}
          </p>
        </div>
        {isAdmin && template.source === "custom" ? <TemplateAdminActions templateKey={template.key} title={template.title} /> : null}
      </div>

      <div className="grid gap-4 px-4 lg:px-6 @5xl/main:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {canDeploy ? (
          env && env.type !== "kubernetes" ? (
            <Card>
              <CardHeader>
                <CardTitle>{t.common.actions.deploy}</CardTitle>
                <CardDescription>
                  {rich(text.deployDescription, {
                    environment: <span className="font-medium text-foreground">{env.name}</span>,
                    command: <code>docker compose up -d</code>,
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <TemplateDeployForm
                  templateKey={template.key}
                  stackName={template.stackName}
                  variables={template.variables}
                  exposable={composeServicePorts(template.compose)}
                  proxyMode={proxyMode}
                />
              </CardContent>
            </Card>
          ) : (
            <DockerUnavailable message={env ? KUBERNETES_ENVIRONMENT : "No Docker environment configured"} />
          )
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{t.common.actions.deploy}</CardTitle>
              <CardDescription>{text.deployNeedsManager}</CardDescription>
            </CardHeader>
          </Card>
        )}
        {/* Custom templates can come from a stack's compose file, which may hold secrets: admins only. */}
        {isAdmin || template.source === "builtin" ? (
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>{text.composeFile}</CardTitle>
              <CardDescription>{rich(text.composeDescription, { variables: "${VARIABLES}" })}</CardDescription>
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
        ) : null}
      </div>
    </PageBody>
  )
}
