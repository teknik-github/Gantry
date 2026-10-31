import type { Metadata } from "next"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"

import { KubeUnavailable, loadKubePage } from "@/components/gantry/kubernetes/page"
import { YamlEditor } from "@/components/gantry/kubernetes/yaml-editor"
import { PageBody } from "@/components/gantry/page-body"
import { PageHeader } from "@/components/gantry/ui"
import { Button } from "@/components/ui/button"
import { editableObject, editableResource, MAX_EDIT_BYTES, toYaml } from "@/lib/kubernetes/edit"
import { namespaceSchema, objectNameSchema } from "@/lib/kubernetes/names"
import { tryKube } from "@/lib/server/kubernetes"

export async function generateMetadata({ params }: PageProps<"/kubernetes/edit/[resource]/[namespace]/[name]">): Promise<Metadata> {
  const { name } = await params
  return { title: `Edit ${decodeURIComponent(name)}` }
}

const BACK: Record<string, { href: string; label: string }> = {
  deployments: { href: "/kubernetes/workloads", label: "Workloads" },
  statefulsets: { href: "/kubernetes/workloads", label: "Workloads" },
  daemonsets: { href: "/kubernetes/workloads", label: "Workloads" },
  services: { href: "/kubernetes/services", label: "Services" },
  ingresses: { href: "/kubernetes/services", label: "Services" },
  configmaps: { href: "/kubernetes/config", label: "ConfigMaps & Secrets" },
  secrets: { href: "/kubernetes/config", label: "ConfigMaps & Secrets" },
}

// Loads the live object for the editor. Editing needs the manager role;
// a Secret's data is only loaded for administrators.
export default async function EditObjectPage({ params }: PageProps<"/kubernetes/edit/[resource]/[namespace]/[name]">) {
  const { resource: rawResource, namespace: rawNs, name: rawName } = await params
  const namespace = decodeURIComponent(rawNs)
  const name = decodeURIComponent(rawName)
  const resource = editableResource(rawResource)
  const backTo = BACK[rawResource] ?? { href: "/kubernetes", label: "Overview" }
  const back = (
    <Button variant="outline" size="sm" asChild>
      <Link href={backTo.href}>
        <ArrowLeftIcon data-icon="inline-start" />
        {backTo.label}
      </Link>
    </Button>
  )
  const header = (description?: string) => (
    <PageHeader title={resource ? `Edit ${resource.kind} ${name}` : "Edit YAML"} description={description} actions={back} />
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
        <KubeUnavailable message="This object can't be edited here" />
      </PageBody>
    )
  }
  if (!page.can.manage) {
    return (
      <PageBody>
        {header(`${resource.kind} in ${namespace}`)}
        <p className="px-4 text-sm text-muted-foreground lg:px-6">Editing objects needs the manager role in this environment.</p>
      </PageBody>
    )
  }
  if ("adminOnly" in resource && resource.adminOnly && page.user.role !== "admin") {
    return (
      <PageBody>
        {header(`${resource.kind} in ${namespace}`)}
        <p className="px-4 text-sm text-muted-foreground lg:px-6">Secret values are shown to and edited by administrators only.</p>
      </PageBody>
    )
  }

  const result = await tryKube(() => page.api.getObject(resource.apiVersion, resource.resource, namespace, name))
  if (result.error !== undefined) {
    return (
      <PageBody>
        {header(`${resource.kind} in ${namespace}`)}
        <KubeUnavailable message={result.error} />
      </PageBody>
    )
  }
  const yaml = toYaml(editableObject(result.data))
  const resourceVersion = String((result.data.metadata as { resourceVersion?: string } | undefined)?.resourceVersion ?? "")
  const tooLarge = Buffer.byteLength(yaml) > MAX_EDIT_BYTES

  return (
    <PageBody>
      {header(`${resource.kind} in ${namespace} · ${resource.apiVersion}`)}
      {tooLarge ? (
        <KubeUnavailable message="This object is too large to edit here; use kubectl edit." />
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
