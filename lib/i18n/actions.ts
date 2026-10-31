"use server"

import { cookies } from "next/headers"

import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/lib/i18n/config"
import type { ActionState } from "@/lib/validation"

/**
 * Remembers the interface language in this browser. Open to anyone (the
 * sign-in page has a switcher too): it only sets the caller's own cookie.
 */
export async function setLocale(locale: string): Promise<ActionState> {
  if (!isLocale(locale)) return { error: "Unknown language" }
  ;(await cookies()).set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
    // Read by the inline script that sets <html lang> before the first paint.
    // Not a secret, so it is fine over plain HTTP too.
    httpOnly: false,
  })
  return { ok: true }
}
