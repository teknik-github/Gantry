"use client"

import { usePathname } from "next/navigation"

import { LiveIndicator } from "@/components/live-updates"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import type { Messages } from "@/lib/i18n"
import { useI18n } from "@/lib/i18n/client"

type Page = keyof Messages["nav"]["pages"]

const TITLES: Record<string, Page> = {
  dashboard: "dashboard",
  containers: "containers",
  images: "images",
  volumes: "volumes",
  networks: "networks",
  stacks: "stacks",
  templates: "templates",
  registries: "registries",
  notifications: "notifications",
  "auto-update": "autoUpdate",
  proxy: "proxy",
  topology: "topology",
  environments: "environments",
  users: "users",
  activity: "activity",
  backups: "backups",
  account: "account",
  kubernetes: "kubernetes",
}

const KUBERNETES_TITLES: Record<string, Page> = {
  workloads: "workloads",
  pods: "pods",
  services: "services",
  namespaces: "namespaces",
  config: "config",
  events: "events",
  apply: "apply",
  helm: "helm",
  charts: "charts",
  edit: "editYaml",
}

export function SiteHeader() {
  const { t } = useI18n()
  const [, segment = "", sub = ""] = usePathname().split("/")
  const pages = t.nav.pages
  const title =
    segment === "kubernetes" && KUBERNETES_TITLES[sub]
      ? `Kubernetes · ${pages[KUBERNETES_TITLES[sub]]}`
      : TITLES[segment]
        ? pages[TITLES[segment]]
        : "Gantry"

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" label={t.nav.sidebar.toggle} />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <h1 className="text-base font-medium">{title}</h1>
        <LiveIndicator className="ml-auto" />
      </div>
    </header>
  )
}
