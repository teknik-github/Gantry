"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useI18n } from "@/lib/i18n/client"
import type { Messages } from "@/lib/i18n"

export type NavItem = {
  /** Page title, from the nav.pages messages. */
  page: keyof Messages["nav"]["pages"]
  url: string
  icon?: React.ReactNode
  /** Only active on this exact path, not on sub-pages. */
  exact?: boolean
}

export function NavMain({ items, group }: { items: NavItem[]; group?: keyof Messages["nav"]["groups"] }) {
  const pathname = usePathname()
  const { t } = useI18n()
  const { isMobile, setOpenMobile } = useSidebar()
  const label = group ? t.nav.groups[group] : null

  return (
    <SidebarGroup>
      {label ? <SidebarGroupLabel>{label}</SidebarGroupLabel> : null}
      <SidebarGroupContent className="flex flex-col gap-2">
        <SidebarMenu>
          {items.map((item) => {
            const active = pathname === item.url || (!item.exact && pathname.startsWith(`${item.url}/`))
            const title = t.nav.pages[item.page]
            return (
              <SidebarMenuItem key={item.url}>
                <SidebarMenuButton
                  asChild
                  tooltip={title}
                  isActive={active}
                  // Crane-yellow marker on the current page.
                  className="data-[active=true]:shadow-[inset_3px_0_0_var(--crane)] data-[active=true]:[&>svg]:text-crane"
                >
                  {/* On phones the sidebar is a sheet: close it once a page is picked. */}
                  <Link href={item.url} onClick={() => isMobile && setOpenMobile(false)}>
                    {item.icon}
                    <span>{title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
