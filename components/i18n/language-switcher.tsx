"use client"

import { useTransition } from "react"
import { CheckIcon, LanguagesIcon } from "lucide-react"
import { toast } from "sonner"

import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { setLocale } from "@/lib/i18n/actions"
import { useI18n } from "@/lib/i18n/client"
import { LOCALE_NAMES, LOCALES, type Locale } from "@/lib/i18n/config"

/**
 * Saves the language and reloads the page. A full reload (rather than a
 * router refresh) also re-renders pages kept in the client router's cache
 * and the <html lang> attribute.
 */
function useSwitchLocale() {
  const { locale, t } = useI18n()
  const [pending, start] = useTransition()
  function switchTo(next: string) {
    if (next === locale) return
    start(async () => {
      try {
        const res = await setLocale(next)
        if (res.error) return void toast.error(res.error)
        window.location.reload()
      } catch {
        toast.error(t.common.errors.requestFailed)
      }
    })
  }
  return { locale, pending, switchTo }
}

/** Language submenu for the user menu. */
export function LanguageMenu() {
  const { t } = useI18n()
  const { locale, pending, switchTo } = useSwitchLocale()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger disabled={pending} data-testid="language-menu">
        <LanguagesIcon />
        {t.nav.user.language}
        <span className="ml-auto pl-2 text-xs text-muted-foreground uppercase">{locale}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        {LOCALES.map((l) => (
          <DropdownMenuItem key={l} lang={l} onSelect={() => switchTo(l)}>
            {LOCALE_NAMES[l]}
            {l === locale ? <CheckIcon className="ml-auto" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Language select for the Account page and the sign-in screens. */
export function LanguageSelect({ id = "language", className }: { id?: string; className?: string }) {
  const { t } = useI18n()
  const { locale, pending, switchTo } = useSwitchLocale()
  return (
    <Select value={locale} onValueChange={(v) => switchTo(v as Locale)} disabled={pending}>
      <SelectTrigger id={id} className={className} aria-label={t.common.language.label} data-testid="language-select">
        <LanguagesIcon />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LOCALES.map((l) => (
          <SelectItem key={l} value={l} lang={l}>
            {LOCALE_NAMES[l]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
