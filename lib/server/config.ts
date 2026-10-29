import "server-only"

import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"

export type DbDriver = "sqlite" | "mysql"

function env(name: string, fallback?: string) {
  const value = process.env[name]
  return value === undefined || value === "" ? fallback : value
}

export const config = {
  dataDir: path.resolve(env("DATA_DIR", "./data")!),
  dbDriver: (env("DB_DRIVER", "sqlite") as DbDriver),
  sqlitePath: env("SQLITE_PATH"),
  mysql: {
    url: env("DATABASE_URL"),
    host: env("MYSQL_HOST", "127.0.0.1")!,
    port: Number(env("MYSQL_PORT", "3306")),
    user: env("MYSQL_USER", "gantry")!,
    password: env("MYSQL_PASSWORD", "")!,
    database: env("MYSQL_DATABASE", "gantry")!,
  },
  dockerSocket: env("DOCKER_SOCKET", "/var/run/docker.sock")!,
  /** "true" | "false" | "auto" (secure when the request came in over https) */
  cookieSecure: env("COOKIE_SECURE", "auto")!,
  sessionTtlHours: Number(env("SESSION_TTL_HOURS", "12")),
  /** Set when a reverse proxy you control sets X-Forwarded-For. */
  trustProxy: env("TRUST_PROXY", "false") === "true",
}

if (config.dbDriver !== "sqlite" && config.dbDriver !== "mysql") {
  throw new Error(`DB_DRIVER must be "sqlite" or "mysql", got "${config.dbDriver}"`)
}

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true })
  return config.dataDir
}

let cachedSecret: Uint8Array | undefined

/**
 * Secret used to sign session tokens. Taken from GANTRY_SECRET, otherwise
 * generated once and persisted in the data directory so sessions survive
 * restarts. Shared by proxy.ts and the server runtime.
 */
export function getSessionSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret

  const fromEnv = env("GANTRY_SECRET")
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error("GANTRY_SECRET must be at least 32 characters long")
    }
    cachedSecret = new TextEncoder().encode(fromEnv)
    return cachedSecret
  }

  const file = path.join(ensureDataDir(), "secret.key")
  let secret: string
  try {
    secret = fs.readFileSync(file, "utf8").trim()
  } catch {
    secret = crypto.randomBytes(48).toString("base64url")
    try {
      fs.writeFileSync(file, secret, { mode: 0o600, flag: "wx" })
    } catch {
      // Another worker created it first; use theirs.
      secret = fs.readFileSync(file, "utf8").trim()
    }
  }
  cachedSecret = new TextEncoder().encode(secret)
  return cachedSecret
}
