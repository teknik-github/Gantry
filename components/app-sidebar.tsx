"use client"

import * as React from "react"
import {
  LayoutDashboardIcon,
  BoxIcon,
  LayersIcon,
  HardDriveIcon,
  NetworkIcon,
  LayersPlusIcon,
  WaypointsIcon,
  ServerIcon,
  UsersIcon,
  BellIcon,
  GlobeIcon,
  ArchiveIcon,
  HistoryIcon,
  RefreshCwIcon,
  KeyRoundIcon,
  LayoutTemplateIcon,
  ShipWheelIcon,
  ContainerIcon,
  CuboidIcon,
  WorkflowIcon,
  FolderTreeIcon,
  FileCogIcon,
  TriangleAlertIcon,
  FileUpIcon,
  PackageIcon,
} from "lucide-react"

import { NavMain, type NavItem } from "@/components/nav-main"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar"

const navDocker: NavItem[] = [
  { page: "dashboard", url: "/dashboard", icon: <LayoutDashboardIcon /> },
  { page: "containers", url: "/containers", icon: <BoxIcon /> },
  { page: "images", url: "/images", icon: <LayersIcon /> },
  { page: "volumes", url: "/volumes", icon: <HardDriveIcon /> },
  { page: "networks", url: "/networks", icon: <NetworkIcon /> },
  { page: "stacks", url: "/stacks", icon: <LayersPlusIcon /> },
  { page: "templates", url: "/templates", icon: <LayoutTemplateIcon /> },
  { page: "topology", url: "/topology", icon: <WaypointsIcon /> },
]

const navKubernetes: NavItem[] = [
  { page: "overview", url: "/kubernetes", icon: <ShipWheelIcon />, exact: true },
  { page: "workloads", url: "/kubernetes/workloads", icon: <ContainerIcon /> },
  { page: "pods", url: "/kubernetes/pods", icon: <CuboidIcon /> },
  { page: "services", url: "/kubernetes/services", icon: <WorkflowIcon /> },
  { page: "namespaces", url: "/kubernetes/namespaces", icon: <FolderTreeIcon /> },
  { page: "config", url: "/kubernetes/config", icon: <FileCogIcon /> },
  { page: "events", url: "/kubernetes/events", icon: <TriangleAlertIcon /> },
  { page: "helm", url: "/kubernetes/helm", icon: <PackageIcon /> },
  { page: "apply", url: "/kubernetes/apply", icon: <FileUpIcon /> },
]

const navAdmin: NavItem[] = [
  { page: "environments", url: "/environments", icon: <ServerIcon /> },
  { page: "registries", url: "/registries", icon: <KeyRoundIcon /> },
  { page: "notifications", url: "/notifications", icon: <BellIcon /> },
  { page: "autoUpdate", url: "/auto-update", icon: <RefreshCwIcon /> },
  { page: "proxy", url: "/proxy", icon: <GlobeIcon /> },
  { page: "users", url: "/users", icon: <UsersIcon /> },
  { page: "activity", url: "/activity", icon: <HistoryIcon /> },
  { page: "backups", url: "/backups", icon: <ArchiveIcon /> },
]

export function AppSidebar({
  header,
  footer,
  nav,
  showAdmin,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  header: React.ReactNode
  footer: React.ReactNode
  /** DockerNav or KubernetesNav, depending on the current environment. */
  nav: React.ReactNode
  showAdmin: React.ReactNode
}) {
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>{header}</SidebarHeader>
      <SidebarContent>
        {nav}
        {showAdmin}
      </SidebarContent>
      <SidebarFooter>{footer}</SidebarFooter>
    </Sidebar>
  )
}

export function DockerNav() {
  return <NavMain items={navDocker} group="docker" />
}

export function KubernetesNav() {
  return <NavMain items={navKubernetes} group="kubernetes" />
}

export function AdminNav() {
  return <NavMain items={navAdmin} group="administration" />
}

// Environment-level settings a manager (not administrator) of the current Docker environment may change.
const navManager = navAdmin.filter((i) => i.url === "/auto-update" || i.url === "/proxy")

export function ManagerNav() {
  return <NavMain items={navManager} group="environment" />
}
