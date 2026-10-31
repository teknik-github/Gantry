import type { en } from "@/lib/i18n/dictionaries/en"

/** The English messages, with their literal text (placeholder names are type-checked from it). */
export type Messages = typeof en

/** Widens the literal strings so another language can fill in its own text. */
type Widen<T> = T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> }

/** What every language must provide: the same keys as English. A missing key is a type error. */
export type Dictionary = Widen<Messages>
