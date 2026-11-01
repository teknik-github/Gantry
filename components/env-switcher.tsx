"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckIcon, ChevronsUpDownIcon, RadioTowerIcon, ServerIcon, ShipWheelIcon } from "lucide-react"

import { selectEnvironment } from "@/app/(app)/environments/actions"
import { switcherAgents } from "@/app/(app)/environments/agent-actions"
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
import { cn } from "@/lib/utils"

type AgentState = { connected: boolean; hostname: string | null; dockerVersion: string | null }
type Env = { id: number; name: string; type: string; url: string; agent: AgentState | null }

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
  const { t, format } = useI18n()
  const text = t.nav.environments
  // Agents connect and disconnect on their own: refreshed whenever the menu opens.
  const [agents, setAgents] = useState<Record<number, AgentState>>({})
  const agentOf = (env: Env) => (env.agent ? (agents[env.id] ?? env.agent) : null)
  const onOpenChange = (open: boolean) => {
    if (!open || !environments.some((e) => e.agent)) return
    switcherAgents().then(setAgents, () => {})
  }

  /** Host name and Docker version the agent reported, and whether it is connected, instead of agent://<id>. */
  const agentLine = (agent: AgentState) => {
    const host = [agent.hostname, agent.dockerVersion ? format(text.agentDocker, { version: agent.dockerVersion }) : null]
      .filter(Boolean)
      .join(" · ")
    if (!host) return agent.connected ? text.agentConnectedUnknown : text.agentNeverConnected
    return format(agent.connected ? text.agentConnected : text.agentDisconnected, { host })
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu onOpenChange={onOpenChange}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" disabled={pending}>
              <GantryMark className="size-8 rounded-lg" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Gantry</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {current && agentOf(current) ? (
                    <span
                      className={cn("size-1.5 shrink-0 rounded-full", agentOf(current)!.connected ? "bg-emerald-500" : "bg-red-500")}
                      title={agentLine(agentOf(current)!)}
                      aria-hidden
                    />
                  ) : null}
                  <span className="truncate">{current ? current.name : isAdmin ? text.noEnvironment : text.noEnvironmentAssigned}</span>
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
                {env.type === "kubernetes" ? <ShipWheelIcon /> : env.type === "agent" ? <RadioTowerIcon /> : <ServerIcon />}
                <div className="grid flex-1 leading-tight">
                  <span>{env.name}</span>
                  {agentOf(env) ? (
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="switcher-agent">
                      <span
                        className={cn("size-1.5 shrink-0 rounded-full", agentOf(env)!.connected ? "bg-emerald-500" : "bg-red-500")}
                        aria-hidden
                      />
                      <span className="truncate">{agentLine(agentOf(env)!)}</span>
                    </span>
                  ) : (
                    <span className="truncate text-xs text-muted-foreground">{env.url}</span>
                  )}
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
