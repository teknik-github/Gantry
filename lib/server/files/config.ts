import "server-only"

/** Limits of the file browser, from the environment (documented in docs/configuration.md). */

function number(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]
  const n = raw === undefined || raw === "" ? fallback : Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function filesConfig() {
  return {
    /** Largest file one upload may carry. */
    uploadMaxBytes: number("FILES_UPLOAD_MAX_MB", 512, 1, 64 * 1024) * 1024 * 1024,
    /** Largest file the text editor opens and saves. */
    editMaxBytes: number("FILES_EDIT_MAX_KB", 1024, 1, 16 * 1024) * 1024,
    /** Entries returned per folder listing (the rest are counted, not shown). */
    listMaxEntries: number("FILES_LIST_MAX_ENTRIES", 5000, 100, 100_000),
    /**
     * Listing without exec (stopped or shell-less containers) reads Docker's
     * tar archive of the folder, including every file body below it: stop
     * after this many bytes or seconds and show what was found.
     */
    scanMaxBytes: number("FILES_SCAN_MAX_MB", 512, 1, 64 * 1024) * 1024 * 1024,
    scanTimeoutMs: number("FILES_SCAN_TIMEOUT_SECONDS", 30, 1, 600) * 1000,
    /** How long a volume helper container is kept for reuse after its last operation. */
    helperIdleMs: number("FILES_HELPER_IDLE_SECONDS", 120, 5, 3600) * 1000,
    /** Image of the short-lived containers that open volumes (needs sh, stat, rm). */
    helperImage: process.env.FILES_HELPER_IMAGE || "alpine:3",
  }
}

export type FilesLimits = { uploadMaxBytes: number; editMaxBytes: number }

/** What the browser needs to know to refuse early. */
export function filesLimits(): FilesLimits {
  const c = filesConfig()
  return { uploadMaxBytes: c.uploadMaxBytes, editMaxBytes: c.editMaxBytes }
}
