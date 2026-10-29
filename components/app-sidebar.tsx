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
} from "lucide-react"

import { NavMain } from "@/components/nav-main"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar"

const navMain = [
  { title: "Dashboard", url: "/dashboard", icon: <LayoutDashboardIcon /> },
  { title: "Containers", url: "/containers", icon: <BoxIcon /> },
  { title: "Images", url: "/images", icon: <LayersIcon /> },
  { title: "Volumes", url: "/volumes", icon: <HardDriveIcon /> },
  { title: "Networks", url: "/networks", icon: <NetworkIcon /> },
  { title: "Stacks", url: "/stacks", icon: <LayersPlusIcon /> },
  { title: "Topology", url: "/topology", icon: <WaypointsIcon /> },
]

const navAdmin = [
  { title: "Environments", url: "/environments", icon: <ServerIcon /> },
  { title: "Users", url: "/users", icon: <UsersIcon /> },
  { title: "Activity", url: "/activity", icon: <HistoryIcon /> },
]

export function AppSidebar({
  header,
  footer,
  showAdmin,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  header: React.ReactNode
  footer: React.ReactNode
  showAdmin: React.ReactNode
}) {
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>{header}</SidebarHeader>
      <SidebarContent>
        <NavMain items={navMain} label="Docker" />
        {showAdmin}
      </SidebarContent>
      <SidebarFooter>{footer}</SidebarFooter>
    </Sidebar>
  )
}

export function AdminNav() {
  return <NavMain items={navAdmin} label="Administration" />
}
