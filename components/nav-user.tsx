"use client"

import Link from "next/link"
import { useTheme } from "next-themes"

import { logout, logoutEverywhere } from "@/app/(auth)/actions"
import { LanguageMenu } from "@/components/i18n/language-switcher"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  EllipsisVerticalIcon,
  CircleUserRoundIcon,
  LogOutIcon,
  MonitorOffIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react"

import { useI18n } from "@/lib/i18n/client"

export function NavUser({ user }: { user: { username: string; role: string } }) {
  const { isMobile } = useSidebar()
  const { resolvedTheme, setTheme } = useTheme()
  const { t } = useI18n()
  const roleLabel = user.role === "admin" ? t.nav.user.roleAdmin : user.role === "user" ? t.nav.user.roleUser : user.role
  const initials = user.username.slice(0, 2).toUpperCase()

  const identity = (
    <>
      <Avatar className="h-8 w-8 rounded-lg">
        <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{user.username}</span>
        <span className="truncate text-xs text-muted-foreground">{roleLabel}</span>
      </div>
    </>
  )

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {identity}
              <EllipsisVerticalIcon className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">{identity}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link href="/account">
                  <CircleUserRoundIcon />
                  {t.nav.user.account}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              >
                {resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
                {resolvedTheme === "dark" ? t.nav.user.lightMode : t.nav.user.darkMode}
              </DropdownMenuItem>
              <LanguageMenu />
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => logout()}>
              <LogOutIcon />
              {t.nav.user.logOut}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => logoutEverywhere()}>
              <MonitorOffIcon />
              {t.nav.user.signOutEverywhere}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
