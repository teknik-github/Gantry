export function formatBytes(bytes: number, digits = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : digits)} ${units[i]}`
}

export function shortId(id: string) {
  return id.replace(/^sha256:/, "").slice(0, 12)
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" })

export function timeAgo(date: Date | number | string) {
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

export function formatDate(date: string) {
  return new Date(date).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })
}
