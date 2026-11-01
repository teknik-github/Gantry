import "server-only"

import { LocaleProvider } from "@/lib/i18n/client"
import { getLocale } from "@/lib/i18n/server"

/**
 * Gives client components below it the visitor's language. It reads the
 * language cookie, so render it inside a <Suspense> boundary.
 */
export async function LocaleScope({ children }: { children: React.ReactNode }) {
  return <LocaleProvider locale={await getLocale()}>{children}</LocaleProvider>
}
