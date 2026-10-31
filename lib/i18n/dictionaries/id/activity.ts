import type { Dictionary } from "@/lib/i18n/dictionaries/types"

export const activity: Dictionary["activity"] = {
  description: "{limit} aksi terakhir yang dilakukan di Gantry.",
  columns: {
    at: "Waktu",
    username: "Pengguna",
    action: "Aksi",
    target: "Target",
  },
  searchPlaceholder: "Filter aktivitas…",
  empty: "Belum ada aktivitas.",
}
