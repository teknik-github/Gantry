"use client"

import { createContext, useContext, useSyncExternalStore } from "react"

import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/config"
import { i18nFor, type I18n } from "@/lib/i18n"

const LocaleContext = createContext<Locale | null>(null)

/** Provides the request's language to client components (see components/i18n/locale-scope.tsx). */
export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
}

const noSubscribe = () => () => {}

/** <html lang>, which the inline script in app/layout.tsx sets from the cookie before the first paint. */
function documentLocale(): Locale {
  const lang = document.documentElement.lang
  return isLocale(lang) ? lang : DEFAULT_LOCALE
}

/**
 * Translation helpers for client components. Inside a LocaleProvider (every
 * page and the sidebar) the server picked the language. Outside one, e.g.
 * in the static app shell, it renders English on the server and switches to
 * the document's language after hydration.
 */
export function useI18n(): I18n {
  const provided = useContext(LocaleContext)
  const fallback = useSyncExternalStore(noSubscribe, documentLocale, () => DEFAULT_LOCALE)
  return i18nFor(provided ?? fallback)
}
