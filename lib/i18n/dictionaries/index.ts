import type { Locale } from "@/lib/i18n/config"
import { en } from "@/lib/i18n/dictionaries/en"
import { id } from "@/lib/i18n/dictionaries/id"
import type { Dictionary } from "@/lib/i18n/dictionaries/types"

export type { Dictionary, Messages } from "@/lib/i18n/dictionaries/types"

export const dictionaries: Record<Locale, Dictionary> = { en, id }
