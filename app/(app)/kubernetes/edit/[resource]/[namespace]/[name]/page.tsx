import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { KubeUnavailable, loadKubePage } from "@/components/gantry/kubernetes/page"
import { YamlEditor } from "@/components/gantry/kubernetes/yaml-editor"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { getI18n } from "@/lib/i18n/server"
import { editableObject, editableResource, MAX_EDIT_BYTES, toYaml } from "@/lib/kubernetes/edit"
import { namespaceSchema, objectNameSchema } from "@/lib/kubernetes/names"
import { tryKube } from "@/lib/server/kubernetes"

export async function generateMetadata({ params }: PageProps<"/kubernetes/edit/[resource]/[namespace]/[name]">): Promise<Metadata> {
  const { name } = await params
  const { t, format } = await getI18n()
  return { title: format(t.kubernetes.edit.title, { name: decodeURIComponent(name) }) }
}

type BackPage = "workloads" | "services" | "config" | "overview"

/** The list page to go back to; the label is the page title (t.nav.pages). */
const BACK: Record<string, { href: string; page: BackPage }> = {
  deployments: { href: "/kubernetes/workloads", page: "workloads" },
  statefulsets: { href: "/kubernetes/workloads", page: "workloads" },
  daemonsets: { href: "/kubernetes/workloads", page: "workloads" },
  services: { href: "/kubernetes/services", page: "services" },
  ingresses: { href: "/kubernetes/services", page: "services" },
  configmaps: { href: "/kubernetes/config", page: "config" },
  secrets: { href: "/kubernetes/config", page: "config" },
}

// Loads the live object for the editor. Editing needs the manager role;
// a Secret's data is only loaded for administrators.
export default async function EditObjectPage({ params }: PageProps<"/kubernetes/edit/[resource]/[namespace]/[name]">) {
  const { resource: rawResource, namespace: rawNs, name: rawName } = await params
  const namespace = decodeURIComponent(rawNs)
  const name = decodeURIComponent(rawName)
  const resource = editableResource(rawResource)
  const { t, format } = await getI18n()
  const k = t.kubernetes
  const backTo = BACK[rawResource] ?? { href: "/kubernetes", page: "overview" as const }
  const back = (
    <Button variant="outline" size="sm" asChild>
      <Link href={backTo.href}>
        <ArrowLeftIcon data-icon="inline-start" />
        {t.nav.pages[backTo.page]}
      </Link>
    </Button>
  )
  const header = (description?: string) => (
    <PageHeader title={resource ? format(k.edit.titleKind, { kind: resource.kind, name }) : t.nav.pages.editYaml} description={description} actions={back} />
  )

  const { page, blocked } = await loadKubePage()
  if (!page) {
    return (
      <PageBody>
        {header()}
        {blocked}
      </PageBody>
    )
  }
  if (!resource || !namespaceSchema.safeParse(namespace).success || !objectNameSchema.safeParse(name).success) {
    return (
      <PageBody>
        {header()}
        <KubeUnavailable message={k.edit.cannotEdit} />
      </PageBody>
    )
  }
  if (!page.can.manage) {
    return (
      <PageBody>
        {header(format(k.common.inNamespace, { kind: resource.kind, namespace }))}
        <p className="px-4 text-sm text-muted-foreground lg:px-6">{k.common.managerOnlyEdit}</p>
      </PageBody>
    )
  }
  if ("adminOnly" in resource && resource.adminOnly && page.user.role !== "admin") {
    return (
      <PageBody>
        {header(format(k.common.inNamespace, { kind: resource.kind, namespace }))}
        <p className="px-4 text-sm text-muted-foreground lg:px-6">{k.edit.secretsAdminOnly}</p>
      </PageBody>
    )
  }

  const result = await tryKube(() => page.api.getObject(resource.apiVersion, resource.resource, namespace, name))
  if (result.error !== undefined) {
    return (
      <PageBody>
        {header(format(k.common.inNamespace, { kind: resource.kind, namespace }))}
        <KubeUnavailable message={result.error} />
      </PageBody>
    )
  }
  const yaml = toYaml(editableObject(result.data))
  const resourceVersion = String((result.data.metadata as { resourceVersion?: string } | undefined)?.resourceVersion ?? "")
  const tooLarge = Buffer.byteLength(yaml) > MAX_EDIT_BYTES

  return (
    <PageBody>
      {header(format(k.common.inNamespaceVersion, { kind: resource.kind, namespace, apiVersion: resource.apiVersion }))}
      {tooLarge ? (
        <KubeUnavailable message={k.edit.tooLarge} />
      ) : (
        <YamlEditor
          key={resourceVersion}
          environmentId={page.env.id}
          resource={resource.resource}
          kind={resource.kind}
          namespace={namespace}
          name={name}
          yaml={yaml}
          resourceVersion={resourceVersion}
        />
      )}
    </PageBody>
  )
}
