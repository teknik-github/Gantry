// Languages of the interface. Safe to import from client and server code.
// See docs/i18n.md for adding a language.

export const LOCALES = ["en", "id"] as const
export type Locale = (typeof LOCALES)[number]

/** English is the source language: every other dictionary is typed after it. */
export const DEFAULT_LOCALE: Locale = "en"

/**
 * Cookie holding the chosen language (per browser). Not httpOnly: the inline
 * script in app/layout.tsx reads it to set <html lang> before the first paint.
 */
export const LOCALE_COOKIE = "gantry-locale"
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** Each language's name, written in that language (for the switcher). */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  id: "Bahasa Indonesia",
}

/** BCP 47 tags used by Intl for dates, numbers and plural rules. */
export const INTL_LOCALES: Record<Locale, { dates: string; numbers: string }> = {
  // en-GB keeps the day-month-year dates Gantry always showed.
  en: { dates: "en-GB", numbers: "en" },
  id: { dates: "id-ID", numbers: "id-ID" },
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value)
}
