import type { Dictionary } from "@/lib/i18n/dictionaries/types"

export const auth: Dictionary["auth"] = {
  brand: {
    title: "Semua host Docker, stack, dan cluster dalam satu tempat.",
    body: "Jalankan, perbarui, dan ekspos container, deploy stack dari template atau Git, dan dapatkan notifikasi saat ada masalah.",
  },
  titles: {
    login: "Login",
    setup: "Setup",
    twoFactor: "Autentikasi dua faktor",
  },
  login: {
    title: "Login ke Gantry",
    description: "Masukkan username dan password Anda untuk melanjutkan",
    adminsOnly: "Login dengan SSO. Form password hanya untuk administrator.",
    signingIn: "Sedang login…",
    submit: "Login",
    forgot: "Lupa password? Minta administrator Gantry untuk me-reset-nya.",
    or: "Atau",
    sso: "Login dengan SSO",
  },
  sso: {
    not_linked:
      "Akun SSO ini belum terhubung ke pengguna Gantry. Minta ke administrator, atau login dengan password lalu hubungkan di halaman Akun.",
    failed: "Single sign-on gagal. Coba lagi atau minta administrator memeriksa log server.",
    denied: "Single sign-on dibatalkan.",
    expired: "Percobaan single sign-on sudah kedaluwarsa. Coba lagi.",
    unavailable: "Single sign-on sedang tidak tersedia.",
  },
  setup: {
    title: "Selamat datang di Gantry",
    description: "Buat akun administrator untuk menyelesaikan setup",
    token: "Token setup",
    tokenHelp: "Tercetak di log server ({logs}) dan disimpan di {file}.",
    confirm: "Konfirmasi password",
    creating: "Membuat…",
    submit: "Buat administrator",
    passwordHint: "Gunakan minimal 8 karakter untuk password.",
  },
  twoFactor: {
    title: "Autentikasi dua faktor",
    description: "Masukkan kode 6 digit dari aplikasi authenticator Anda",
    code: "Kode",
    lostDevice: "Perangkat hilang? Masukkan salah satu kode pemulihan Anda.",
    verifying: "Memverifikasi…",
    verify: "Verifikasi",
    anotherAccount: "Gunakan akun lain",
  },
  errors: {
    enterCredentials: "Masukkan username dan password Anda",
    tooManyAttempts: "Terlalu banyak percobaan. Coba lagi dalam {seconds} detik.",
    passwordBusy: "Terlalu banyak percobaan login saat ini. Coba lagi sebentar lagi.",
    invalidCredentials: "Username atau password salah",
    ssoOnly: "Login dengan SSO. Login dengan password hanya untuk administrator.",
    pendingExpired: "Login ini sudah kedaluwarsa. Mulai lagi dengan password Anda.",
    enterCode: "Masukkan kode",
    invalidCode: "Kode tidak valid",
    passwordsMismatch: "Password tidak cocok",
    alreadySetUp: "Gantry sudah di-setup. Silakan login.",
    invalidSetupToken: "Token setup tidak valid",
  },
}
