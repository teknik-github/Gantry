import type { Generated, Insertable, Selectable } from "kysely"

export type Role = "admin" | "user"
export type EnvironmentType = "socket" | "tcp"

export interface UsersTable {
  id: Generated<number>
  username: string
  password_hash: string
  role: Role
  created_at: string
}

export interface EnvironmentsTable {
  id: Generated<number>
  name: string
  type: EnvironmentType
  /** Socket path for "socket", host:port for "tcp" */
  url: string
  created_at: string
  /** TLS material for "tcp", encrypted at rest (see lib/server/crypto.ts). Null = plain HTTP. */
  tls_ca: string | null
  tls_cert: string | null
  tls_key: string | null
}

/** Environments a standard user may see and use. Admins can use all of them. */
export interface EnvironmentAccessTable {
  user_id: number
  environment_id: number
  created_at: string
}

export interface AuditLogsTable {
  id: Generated<number>
  user_id: number | null
  username: string
  action: string
  target: string
  created_at: string
}

export type StackRunStatus = "success" | "error"

export interface StacksTable {
  id: Generated<number>
  environment_id: number
  /** Compose project name (`-p`), unique per environment */
  name: string
  compose: string
  /** dotenv text written to the stack's .env, may be empty */
  env: string
  created_by: string
  created_at: string
  updated_at: string
  /** Outcome of the last docker compose run, shown on the stack page */
  last_action: string | null
  last_status: StackRunStatus | null
  last_output: string | null
  last_run_at: string | null
  last_run_by: string | null
}

/** Periodic resource usage samples per environment (lib/server/metrics-sampler.ts). */
export interface MetricsTable {
  id: Generated<number>
  environment_id: number
  /** ISO timestamp of the sample */
  ts: string
  /** Running containers */
  containers: number
  /** CPU % normalised to the host's CPUs */
  cpu: number
  /** Bytes; stored as double so MySQL returns numbers, not BIGINT strings */
  mem_used: number
  mem_total: number
}

/** Login for a private container registry. */
export interface RegistriesTable {
  id: Generated<number>
  name: string
  /** host[:port], normalised; "docker.io" for Docker Hub */
  address: string
  username: string
  /** Password or access token, encrypted at rest (lib/server/crypto.ts) */
  password: string
  created_at: string
  updated_at: string
}

/** Custom stack template; built-in ones are in lib/template-catalog.ts. */
export interface TemplatesTable {
  id: Generated<number>
  title: string
  description: string
  category: string
  /** Suggested stack name when deploying */
  stack_name: string
  compose: string
  /** dotenv with default values for the compose file's ${VARIABLES} */
  env: string
  created_by: string
  created_at: string
  updated_at: string
}

export interface NotificationChannelsTable {
  id: Generated<number>
  name: string
  /** lib/notifications.ts CHANNEL_TYPES */
  type: string
  /** JSON settings, encrypted at rest (lib/server/crypto.ts) */
  config: string
  /** JSON array of alert kinds */
  events: string
  /** 1 or 0 (portable boolean) */
  enabled: number
  created_at: string
  updated_at: string
}

/** Alerts that were raised, with how their delivery went. */
export interface AlertsTable {
  id: Generated<number>
  environment_id: number | null
  environment_name: string
  kind: string
  subject: string
  message: string
  delivery: string
  created_at: string
}

/** Containers (by name) updated automatically on schedule. */
export interface AutoUpdateRulesTable {
  environment_id: number
  container_name: string
  created_at: string
}

export interface SettingsTable {
  key: string
  value: string
}

export interface ProxySettingsTable {
  environment_id: number
  /** lib/proxy.ts PROXY_MODES */
  mode: string
  http_port: number
  https_port: number
  email: string
  external_network: string
  last_error: string | null
  applied_at: string | null
  updated_at: string
}

export interface ProxyHostsTable {
  id: Generated<number>
  environment_id: number
  /** Comma-separated domains */
  domains: string
  /** Container name */
  target: string
  port: number
  /** lib/proxy.ts TLS_MODES */
  tls: string
  enabled: number
  created_at: string
  updated_at: string
}

export interface Database {
  users: UsersTable
  environments: EnvironmentsTable
  environment_access: EnvironmentAccessTable
  audit_logs: AuditLogsTable
  stacks: StacksTable
  metrics: MetricsTable
  registries: RegistriesTable
  templates: TemplatesTable
  notification_channels: NotificationChannelsTable
  alerts: AlertsTable
  auto_update_rules: AutoUpdateRulesTable
  settings: SettingsTable
  proxy_settings: ProxySettingsTable
  proxy_hosts: ProxyHostsTable
}

export type User = Selectable<UsersTable>
export type NewUser = Insertable<UsersTable>
export type Environment = Selectable<EnvironmentsTable>
export type AuditLog = Selectable<AuditLogsTable>
export type Stack = Selectable<StacksTable>
export type Metric = Selectable<MetricsTable>
export type NewMetric = Insertable<MetricsTable>
export type Registry = Selectable<RegistriesTable>
export type CustomTemplate = Selectable<TemplatesTable>
