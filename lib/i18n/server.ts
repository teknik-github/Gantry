import "server-only"

import { cache } from "react"
import { cookies } from "next/headers"

import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE, type Locale } from "@/lib/i18n/config"
import { i18nFor, type I18n } from "@/lib/i18n"

/**
 * The language of this request: the visitor's choice (cookie), else English.
 * Reads a cookie, so in a page it must run inside a <Suspense> boundary
 * (Cache Components) like any other request data.
 */
export const getLocale = cache(async (): Promise<Locale> => {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value
  return isLocale(value) ? value : DEFAULT_LOCALE
})

/** Translation helpers for Server Components, Server Actions and Route Handlers. */
export async function getI18n(): Promise<I18n> {
  return i18nFor(await getLocale())
}
