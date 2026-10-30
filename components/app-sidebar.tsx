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
  HistoryIcon,
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
} from "lucide-react"

import { NavMain } from "@/components/nav-main"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar"

const navDocker = [
  { title: "Dashboard", url: "/dashboard", icon: <LayoutDashboardIcon /> },
  { title: "Containers", url: "/containers", icon: <BoxIcon /> },
  { title: "Images", url: "/images", icon: <LayersIcon /> },
  { title: "Volumes", url: "/volumes", icon: <HardDriveIcon /> },
  { title: "Networks", url: "/networks", icon: <NetworkIcon /> },
  { title: "Stacks", url: "/stacks", icon: <LayersPlusIcon /> },
  { title: "Templates", url: "/templates", icon: <LayoutTemplateIcon /> },
  { title: "Topology", url: "/topology", icon: <WaypointsIcon /> },
]

const navKubernetes = [
  { title: "Overview", url: "/kubernetes", icon: <ShipWheelIcon />, exact: true },
  { title: "Workloads", url: "/kubernetes/workloads", icon: <ContainerIcon /> },
  { title: "Pods", url: "/kubernetes/pods", icon: <CuboidIcon /> },
  { title: "Services", url: "/kubernetes/services", icon: <WorkflowIcon /> },
  { title: "Namespaces", url: "/kubernetes/namespaces", icon: <FolderTreeIcon /> },
  { title: "ConfigMaps & Secrets", url: "/kubernetes/config", icon: <FileCogIcon /> },
  { title: "Events", url: "/kubernetes/events", icon: <TriangleAlertIcon /> },
  { title: "Apply manifest", url: "/kubernetes/apply", icon: <FileUpIcon /> },
]

const navAdmin = [
  { title: "Environments", url: "/environments", icon: <ServerIcon /> },
  { title: "Registries", url: "/registries", icon: <KeyRoundIcon /> },
  { title: "Users", url: "/users", icon: <UsersIcon /> },
  { title: "Activity", url: "/activity", icon: <HistoryIcon /> },
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
  return <NavMain items={navDocker} label="Docker" />
}

export function KubernetesNav() {
  return <NavMain items={navKubernetes} label="Kubernetes" />
}

export function AdminNav() {
  return <NavMain items={navAdmin} label="Administration" />
}
