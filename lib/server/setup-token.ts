import "server-only"

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import { config, ensureDataDir } from "@/lib/server/config"

/**
 * One-time token required by /setup while no user exists, so whoever reaches
 * a fresh instance first can't claim it. It comes from GANTRY_SETUP_TOKEN or
 * is generated into $DATA_DIR/setup-token (shared by workers and restarts)
 * and printed to the server log. It is deleted once the admin exists.
 */

function tokenFile() {
  return path.join(config.dataDir, "setup-token")
}

export function getSetupToken(): string {
  const fromEnv = process.env.GANTRY_SETUP_TOKEN?.trim()
  if (fromEnv) {
    if (fromEnv.length < 16) throw new Error("GANTRY_SETUP_TOKEN must be at least 16 characters long")
    return fromEnv
  }

  ensureDataDir()
  try {
    return fs.readFileSync(tokenFile(), "utf8").trim()
  } catch {
    const token = crypto.randomBytes(18).toString("base64url")
    try {
      fs.writeFileSync(tokenFile(), token, { mode: 0o600, flag: "wx" })
      return token
    } catch {
      // Another worker created it first; use theirs.
      return fs.readFileSync(tokenFile(), "utf8").trim()
    }
  }
}

export function verifySetupToken(input: string): boolean {
  const expected = Buffer.from(getSetupToken())
  const actual = Buffer.from(input.trim())
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

export function clearSetupToken() {
  fs.rmSync(tokenFile(), { force: true })
}

export function setupTokenSource() {
  return process.env.GANTRY_SETUP_TOKEN?.trim() ? "the GANTRY_SETUP_TOKEN environment variable" : tokenFile()
}
