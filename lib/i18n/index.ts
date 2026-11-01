// Translation helpers shared by server and client code. Server code gets an
// instance from getI18n() (lib/i18n/server.ts), client components from
// useI18n() (lib/i18n/client.tsx). See docs/i18n.md.

import { createElement, Fragment, type ReactNode } from "react"

import { DEFAULT_LOCALE, INTL_LOCALES, type Locale } from "@/lib/i18n/config"
import { dictionaries, type Messages } from "@/lib/i18n/dictionaries"
import { formatBytes, formatDate, timeAgo } from "@/lib/format"

export type { Locale } from "@/lib/i18n/config"
export type { Dictionary, Messages } from "@/lib/i18n/dictionaries"

/** A message with a singular and a plural form, picked by Intl.PluralRules. */
export type Plural = { readonly one: string; readonly other: string }

type Value = string | number

/** The `{name}` placeholders of a message template, as a union of names. */
export type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never

/** Values for a template's placeholders (any names when the template is a plain string). */
export type Vars<S extends string> = string extends S ? Record<string, Value> : Record<Placeholders<S>, Value>

const PLACEHOLDER = /\{(\w+)\}/g

/** Replaces `{name}` placeholders; unknown names are left as they are. */
export function interpolate(template: string, vars: Record<string, Value> = {}): string {
  return template.replace(PLACEHOLDER, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

/** The placeholder names used in a template, sorted (for the dictionary tests). */
export function placeholdersOf(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort()
}

function createI18n(locale: Locale) {
  const t = dictionaries[locale] as Messages
  const plurals = new Intl.PluralRules(INTL_LOCALES[locale].numbers)
  const numbers = new Intl.NumberFormat(INTL_LOCALES[locale].numbers)

  return {
    locale,
    /** The messages of this language (typed after the English source). */
    t,
    /** Fills a template's `{placeholders}`. */
    format<S extends string>(template: S, vars: Vars<S>): string {
      return interpolate(template, vars as Record<string, Value>)
    },
    /** Picks the singular or plural form for `count`; `{count}` and `vars` are filled in. */
    plural(entry: Plural, count: number, vars: Record<string, Value> = {}): string {
      const form = plurals.select(count) === "one" ? entry.one : entry.other
      return interpolate(form, { count, ...vars })
    },
    /** Like format(), but placeholders may be React nodes (links, code...). */
    rich(template: string, nodes: Record<string, ReactNode>): ReactNode {
      const parts = template.split(PLACEHOLDER)
      // split() with a capture group alternates text and placeholder names.
      return parts.map((part, i) =>
        i % 2 === 0 ? part : createElement(Fragment, { key: i }, part in nodes ? nodes[part] : `{${part}}`)
      )
    },
    formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
      return options ? new Intl.NumberFormat(INTL_LOCALES[locale].numbers, options).format(n) : numbers.format(n)
    },
    formatBytes(bytes: number, digits = 1): string {
      return formatBytes(bytes, digits, locale)
    },
    formatDate(date: Date | string | number): string {
      return formatDate(date, locale)
    },
    timeAgo(date: Date | number | string): string {
      return timeAgo(date, locale)
    },
  }
}

export type I18n = ReturnType<typeof createI18n>

const instances = new Map<Locale, I18n>()

/** The (cached) helpers for a language. */
export function i18nFor(locale: Locale = DEFAULT_LOCALE): I18n {
  let i18n = instances.get(locale)
  if (!i18n) {
    i18n = createI18n(locale)
    instances.set(locale, i18n)
  }
  return i18n
}
