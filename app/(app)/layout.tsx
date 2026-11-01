import { Suspense } from "react"

import { AdminNav, AppSidebar, DockerNav, KubernetesNav, ManagerNav } from "@/components/app-sidebar"
import { EnvSwitcher } from "@/components/env-switcher"
import { LocaleScope } from "@/components/i18n/locale-scope"
import { LiveUpdates } from "@/components/live-updates"
import { NavUser } from "@/components/nav-user"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { agentSummary } from "@/lib/server/agent/hub"
import { requireUser } from "@/lib/server/auth/dal"
import { getCurrentEnvironment, getPermissions, listEnvironments } from "@/lib/server/environments"

import Loading from "./loading"

// Every page below reads the session and live Docker state, so nothing here
// can be prefetched into an instant App Shell; loading.tsx streams instead.
export const instant = false

// dashboard-01 shell. The session is read only inside Suspense boundaries
// so the sidebar chrome stays in the static shell. So is the language cookie:
// each boundary's content is wrapped in a LocaleScope, which renders it in
// the visitor's language on the server (no flash of English).
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
            <LocaleScope>
              <SidebarEnvironments />
            </LocaleScope>
          </Suspense>
        }
        nav={
          <Suspense fallback={<NavSkeleton />}>
            <LocaleScope>
              <SidebarNav />
            </LocaleScope>
          </Suspense>
        }
        showAdmin={
          <Suspense fallback={null}>
            <LocaleScope>
              <SidebarAdmin />
            </LocaleScope>
          </Suspense>
        }
        footer={
          <Suspense fallback={<MenuSkeleton />}>
            <LocaleScope>
              <SidebarUser />
            </LocaleScope>
          </Suspense>
        }
      />
      <SidebarInset>
        <Suspense fallback={<div className="h-(--header-height) border-b" />}>
          <LocaleScope>
            <SiteHeader />
          </LocaleScope>
        </Suspense>
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex min-w-0 flex-1 flex-col gap-2">
            {/* Pages stream in under their own loading.tsx; this boundary only
                waits for the language cookie on the first request. */}
            <Suspense fallback={<Loading />}>
              <LocaleScope>{children}</LocaleScope>
            </Suspense>
          </div>
        </div>
      </SidebarInset>
      <Suspense fallback={null}>
        <LiveUpdatesForEnvironment />
      </Suspense>
    </SidebarProvider>
  )
}

async function SidebarEnvironments() {
  const user = await requireUser()
  const [envs, current] = await Promise.all([listEnvironments(), getCurrentEnvironment()])
  return (
    <EnvSwitcher
      environments={envs.map((e) => ({ id: e.id, name: e.name, type: e.type, url: e.url, agent: e.type === "agent" ? agentSummary(e) : null }))}
      currentId={current?.id ?? null}
      isAdmin={user.role === "admin"}
    />
  )
}

// The Docker or the Kubernetes section, following the current environment.
async function SidebarNav() {
  await requireUser()
  const env = await getCurrentEnvironment()
  return env?.type === "kubernetes" ? <KubernetesNav /> : <DockerNav />
}

// Keyed to the current environment so switching it reconnects the event
// stream: Docker events, or the watches of a Kubernetes environment.
async function LiveUpdatesForEnvironment() {
  await requireUser()
  const env = await getCurrentEnvironment()
  return <LiveUpdates environmentId={env?.id ?? null} />
}

async function SidebarAdmin() {
  const user = await requireUser()
  if (user.role === "admin") return <AdminNav />
  const [env, can] = await Promise.all([getCurrentEnvironment(), getPermissions()])
  return can.manage && env?.type !== "kubernetes" ? <ManagerNav /> : null
}

async function SidebarUser() {
  const user = await requireUser()
  return <NavUser user={{ username: user.username, role: user.role }} />
}

function NavSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-4">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-4 w-3/5" />
      ))}
    </div>
  )
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
