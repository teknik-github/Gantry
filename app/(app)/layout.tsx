import { Suspense } from "react"

import { AdminNav, AppSidebar } from "@/components/app-sidebar"
import { EnvSwitcher } from "@/components/env-switcher"
import { NavUser } from "@/components/nav-user"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, listEnvironments } from "@/lib/server/environments"

// Every page below reads the session and live Docker state, so nothing here
// can be prefetched into an instant App Shell; loading.tsx streams instead.
export const instant = false

// dashboard-01 shell. The session is read only inside Suspense boundaries
// so the sidebar chrome stays in the static shell.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 72)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar
        variant="inset"
        header={
          <Suspense fallback={<MenuSkeleton />}>
            <SidebarEnvironments />
          </Suspense>
        }
        showAdmin={
          <Suspense fallback={null}>
            <SidebarAdmin />
          </Suspense>
        }
        footer={
          <Suspense fallback={<MenuSkeleton />}>
            <SidebarUser />
          </Suspense>
        }
      />
      <SidebarInset>
        <Suspense fallback={<div className="h-(--header-height) border-b" />}>
          <SiteHeader />
        </Suspense>
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col gap-2">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

async function SidebarEnvironments() {
  const user = await requireUser()
  const [envs, current] = await Promise.all([listEnvironments(), getCurrentEnvironment()])
  return (
    <EnvSwitcher
      environments={envs.map(({ id, name, type, url }) => ({ id, name, type, url }))}
      currentId={current?.id ?? null}
      isAdmin={user.role === "admin"}
    />
  )
}

async function SidebarAdmin() {
  const user = await requireUser()
  return user.role === "admin" ? <AdminNav /> : null
}

async function SidebarUser() {
  const user = await requireUser()
  return <NavUser user={{ username: user.username, role: user.role }} />
}

// SidebarMenuSkeleton uses Math.random(), which can't be part of the static shell.
function MenuSkeleton() {
  return (
    <div className="flex h-12 items-center gap-2 px-2">
      <Skeleton className="size-8 rounded-lg" />
      <div className="grid flex-1 gap-1.5">
        <Skeleton className="h-3 w-3/5" />
        <Skeleton className="h-2.5 w-2/5" />
      </div>
    </div>
  )
}
