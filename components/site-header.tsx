"use client"

import { usePathname } from "next/navigation"

import { LiveIndicator } from "@/components/live-updates"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

const TITLES: Record<string, string> = {
  dashboard: "Dashboard",
  containers: "Containers",
  images: "Images",
  volumes: "Volumes",
  networks: "Networks",
  stacks: "Stacks",
  templates: "Templates",
  registries: "Registries",
  notifications: "Notifications",
  "auto-update": "Auto-update",
  proxy: "Proxy",
  topology: "Topology",
  environments: "Environments",
  users: "Users",
  activity: "Activity",
  account: "Account",
  kubernetes: "Kubernetes",
}

const KUBERNETES_TITLES: Record<string, string> = {
  workloads: "Workloads",
  pods: "Pods",
  services: "Services",
  namespaces: "Namespaces",
  config: "ConfigMaps & Secrets",
  events: "Events",
  apply: "Apply manifest",
  helm: "Helm releases",
}

export function SiteHeader() {
  const [, segment = "", sub = ""] = usePathname().split("/")
  const title =
    segment === "kubernetes" && KUBERNETES_TITLES[sub] ? `Kubernetes · ${KUBERNETES_TITLES[sub]}` : (TITLES[segment] ?? "Gantry")

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <h1 className="text-base font-medium">{title}</h1>
        <LiveIndicator className="ml-auto" />
      </div>
    </header>
  )
}
