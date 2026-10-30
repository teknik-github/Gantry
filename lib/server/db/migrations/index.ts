import "server-only"

import type { Migration, MigrationProvider } from "kysely/migration"

import { initial } from "@/lib/server/db/migrations/001_initial"
import { stacks } from "@/lib/server/db/migrations/002_stacks"
import { environmentTls } from "@/lib/server/db/migrations/003_environment_tls"
import { environmentAccess } from "@/lib/server/db/migrations/004_environment_access"
import { metrics } from "@/lib/server/db/migrations/005_metrics"
import { registries } from "@/lib/server/db/migrations/006_registries"
import { templates } from "@/lib/server/db/migrations/007_templates"

// One file per migration, written with Kysely's schema builder only so the
// same migrations run on SQLite and MySQL. Never edit a migration that has
// shipped; add a new file and register it here. Keys sort in apply order.
const migrations: Record<string, Migration> = {
  "001_initial": initial,
  "002_stacks": stacks,
  "003_environment_tls": environmentTls,
  "004_environment_access": environmentAccess,
  "005_metrics": metrics,
  "006_registries": registries,
  "007_templates": templates,
}

export const migrationProvider: MigrationProvider = {
  async getMigrations() {
    return migrations
  },
}
