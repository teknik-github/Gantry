"use client"

import { useTransition } from "react"
import Link from "next/link"
import { toast } from "sonner"
import { CheckIcon, ChevronsUpDownIcon, ServerIcon } from "lucide-react"

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

type Env = { id: number; name: string; type: string; url: string }

export function EnvSwitcher({ environments, currentId }: { environments: Env[]; currentId: number | null }) {
  const [pending, startTransition] = useTransition()
  const current = environments.find((e) => e.id === currentId)

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
                  {current ? current.name : "No environment"}
                </span>
              </div>
              <ChevronsUpDownIcon className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56 rounded-lg" align="start" sideOffset={4}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Environments</DropdownMenuLabel>
            {environments.map((env) => (
              <DropdownMenuItem
                key={env.id}
                onSelect={() =>
                  startTransition(async () => {
                    const res = await selectEnvironment(env.id)
                    if (res.error) toast.error(res.error)
                  })
                }
              >
                <ServerIcon />
                <div className="grid flex-1 leading-tight">
                  <span>{env.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{env.url}</span>
                </div>
                {env.id === currentId ? <CheckIcon className="ml-auto" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/environments">Manage environments</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
