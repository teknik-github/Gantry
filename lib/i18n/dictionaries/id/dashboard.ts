import type { Dictionary } from "@/lib/i18n/dictionaries/types"

export const dashboard: Dictionary["dashboard"] = {
  environmentTitle: "Environment: {name}",
  serverInfo: "Docker {version} · {os} · {cpus} CPU · RAM {memory}",
  setupChecks: {
    title: "Pemeriksaan setup",
    summary: {
      one: "Satu hal yang perlu dibereskan sebelum mengandalkan Gantry.",
      other: "{count} hal yang perlu dibereskan sebelum mengandalkan Gantry.",
    },
    fix: "Perbaiki",
    https: {
      title: "Gantry diakses lewat HTTP biasa",
      detail:
        "Password dan cookie sesi melintasi jaringan tanpa enkripsi. Pasang Gantry di belakang HTTPS, misalnya dengan proxy bawaan (Expose via proxy pada container Gantry sendiri), dan biarkan COOKIE_SECURE=auto.",
      action: "Siapkan proxy",
    },
    cookie: {
      title: "Cookie sesi tidak ditandai Secure",
      detail: "COOKIE_SECURE=false membuat browser juga mengirim sesi lewat HTTP. Setel ke auto (atau true).",
    },
    trustProxy: {
      title: "Berada di belakang proxy, tetapi TRUST_PROXY nonaktif",
      detail:
        "Batas percobaan login tidak bisa membedakan klien dan beralih ke batas per akun. Setel TRUST_PROXY=true jika proxy di depan Gantry milik Anda dan mengisi X-Forwarded-For.",
    },
    backups: {
      title: "Belum ada backup terjadwal",
      detail: "Kredensial environment, pengguna, dan stack hanya tersimpan di database Gantry. Jadwalkan backup harian terenkripsi.",
      action: "Siapkan backup",
    },
    twoFactor: {
      title: "Akun Anda belum memakai autentikasi dua faktor",
      detail: "Administrator mengendalikan semua host Docker di sini; lindungi akun dengan aplikasi authenticator.",
      action: "Aktifkan 2FA",
    },
    notifications: {
      title: "Tidak ada yang menerima peringatan",
      detail: "Container yang crash, host yang tidak bisa dihubungi, dan backup yang gagal hanya tercantum di Gantry. Tambahkan channel agar Anda diberi tahu.",
      action: "Tambah channel",
    },
  },
  cards: {
    containers: "Container",
    running: "{count} berjalan",
    manageContainers: "Kelola container",
    stopped: "{stopped} berhenti",
    stoppedPaused: "{stopped} berhenti, {paused} dijeda",
    images: "Image",
    manageImages: "Kelola image",
    imagesFailed: "Tidak bisa menampilkan daftar image",
    dangling: "{count} dangling, bisa di-prune",
    noDangling: "Tidak ada image dangling",
    volumes: "Volume",
    manageVolumes: "Kelola volume",
    volumesHint: "Penyimpanan data persisten",
    networks: "Network",
    custom: "{count} kustom",
    manageNetworks: "Kelola network",
    networksHint: "Termasuk bawaan: bridge, host, none",
  },
  chart: {
    title: "Pemakaian resource",
    cpu: "CPU",
    memory: "Memori",
    timeRange: "Rentang waktu",
    ranges: {
      live: "Live",
      "1h": "1 jam",
      "24h": "24 jam",
      "7d": "7 hari",
    },
    statsFailed: "Gagal memuat statistik",
    historyFailed: "Gagal memuat riwayat",
    cpuOf: "{value}% dari {ncpu} CPU",
    memoryOf: "{value} dari {total}",
    loadingHistory: "Memuat riwayat…",
    noSamples: "Belum ada sampel yang tercatat",
    avgPeak: "rata-rata {avg} · puncak {peak}",
    avgPeakOf: "rata-rata {avg} · puncak {peak} dari {total}",
    runningContainers: "{count} container berjalan",
    last: "{range} terakhir",
    avg: "rata-rata",
    collecting: "Mengumpulkan riwayat…",
    collectingHelp: "Pemakaian dicatat setiap {seconds} detik. Cek lagi beberapa menit lagi, atau pindah ke Live.",
  },
}
