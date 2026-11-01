"use client"

import { useTransition } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckIcon, ChevronsUpDownIcon, ServerIcon, ShipWheelIcon } from "lucide-react"

import { selectEnvironment } from "@/app/(app)/environments/actions"
import { GantryMark } from "@/components/gantry-logo"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { useI18n } from "@/lib/i18n/client"

type Env = { id: number; name: string; type: string; url: string }

export function EnvSwitcher({
  environments,
  currentId,
  isAdmin,
}: {
  environments: Env[]
  currentId: number | null
  isAdmin: boolean
}) {
  const [pending, startTransition] = useTransition()
  const router = useRouter()
  const pathname = usePathname()
  const current = environments.find((e) => e.id === currentId)
  const { t } = useI18n()
  const text = t.nav.environments

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" disabled={pending}>
              <GantryMark className="size-8 rounded-lg" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Gantry</span>
                <span className="truncate text-xs text-muted-foreground">
                  {current ? current.name : isAdmin ? text.noEnvironment : text.noEnvironmentAssigned}
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56 rounded-lg" align="start" sideOffset={4}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">{text.label}</DropdownMenuLabel>
            {environments.length === 0 ? (
              <DropdownMenuItem disabled>{isAdmin ? text.noEnvironments : text.noneAssigned}</DropdownMenuItem>
            ) : null}
            {environments.map((env) => (
              <DropdownMenuItem
                key={env.id}
                onSelect={() =>
                  startTransition(async () => {
                    const res = await selectEnvironment(env.id)
                    if (res.error) {
                      toast.error(res.error)
                      return
                    }
                    // Docker pages are no use on a cluster and vice versa: go to the matching home page.
                    const onKubernetesPage = pathname === "/kubernetes" || pathname.startsWith("/kubernetes/")
                    if (env.type === "kubernetes" && !onKubernetesPage) router.push("/kubernetes")
                    else if (env.type !== "kubernetes" && onKubernetesPage) router.push("/dashboard")
                  })
                }
              >
                {env.type === "kubernetes" ? <ShipWheelIcon /> : <ServerIcon />}
                <div className="grid flex-1 leading-tight">
                  <span>{env.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{env.url}</span>
                </div>
                {env.id === currentId ? <CheckIcon className="ml-auto" /> : null}
              </DropdownMenuItem>
            ))}
            {isAdmin ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/environments">{text.manage}</Link>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
