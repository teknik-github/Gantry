import { DEFAULT_LOCALE, INTL_LOCALES, type Locale } from "@/lib/i18n/config"

export function formatBytes(bytes: number, digits = 1, locale: Locale = DEFAULT_LOCALE) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  const fraction = i === 0 ? 0 : digits
  // English keeps the plain "1.5 GB" form; other languages get their decimal separator.
  const text =
    locale === "en"
      ? value.toFixed(fraction)
      : new Intl.NumberFormat(INTL_LOCALES[locale].numbers, {
          minimumFractionDigits: fraction,
          maximumFractionDigits: fraction,
          useGrouping: false,
        }).format(value)
  return `${text} ${units[i]}`
}

export function shortId(id: string) {
  return id.replace(/^sha256:/, "").slice(0, 12)
}

/** A listed container's name without the leading slash, or its short id. */
export function containerName(c: { Names?: string[] | null; Id: string }) {
  return c.Names?.[0]?.replace(/^\//, "") || c.Id.slice(0, 12)
}

const relativeFormats = new Map<Locale, Intl.RelativeTimeFormat>()

function relative(locale: Locale) {
  let rtf = relativeFormats.get(locale)
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
    relativeFormats.set(locale, rtf)
  }
  return rtf
}

export function timeAgo(date: Date | number | string, locale: Locale = DEFAULT_LOCALE) {
  const rtf = relative(locale)
  const d = typeof date === "number" ? new Date(date * 1000) : new Date(date)
  const seconds = Math.round((d.getTime() - Date.now()) / 1000)
  const abs = Math.abs(seconds)
  if (abs < 60) return rtf.format(seconds, "second")
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute")
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour")
  if (abs < 86400 * 30) return rtf.format(Math.round(seconds / 86400), "day")
  if (abs < 86400 * 365) return rtf.format(Math.round(seconds / (86400 * 30)), "month")
  return rtf.format(Math.round(seconds / (86400 * 365)), "year")
}

export function formatDate(date: Date | string | number, locale: Locale = DEFAULT_LOCALE) {
  return new Date(date).toLocaleString(INTL_LOCALES[locale].dates, { dateStyle: "medium", timeStyle: "short" })
}
