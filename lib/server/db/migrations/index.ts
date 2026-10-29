import "server-only"

import type { Migration, MigrationProvider } from "kysely/migration"

import { initial } from "@/lib/server/db/migrations/001_initial"

// One file per migration, written with Kysely's schema builder only so the
// same migrations run on SQLite and MySQL. Never edit a migration that has
// shipped; add a new file and register it here. Keys sort in apply order.
const migrations: Record<string, Migration> = {
  "001_initial": initial,
}

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations
  },
}
