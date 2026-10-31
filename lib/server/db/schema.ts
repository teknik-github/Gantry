import type { Generated, Insertable, Selectable } from "kysely"

import type { EnvironmentRole } from "@/lib/permissions"

export type Role = "admin" | "user"
export type EnvironmentType = "socket" | "tcp" | "kubernetes"
/** Environment types that talk to a Docker Engine. */
export type DockerEnvironmentType = Exclude<EnvironmentType, "kubernetes">

export interface UsersTable {
  id: Generated<number>
  username: string
  password_hash: string
  role: Role
  created_at: string
  /** TOTP secret (base32), encrypted at rest. Set while enrolling, kept once enabled. */
  totp_secret: string | null
  /** 1 once a code was verified; login then asks for a code. */
  totp_enabled: Generated<number>
  /** Last accepted TOTP time step, so a code can't be used twice. */
  totp_last_step: number | null
  /** Carried in session tokens; bumping it signs the user out everywhere. */
  session_version: Generated<number>
  /** OIDC identity this user signs in with (issuer + subject); null = local only. */
  oidc_issuer: string | null
  oidc_subject: string | null
}

export interface EnvironmentsTable {
  id: Generated<number>
  name: string
  type: EnvironmentType
  /** Socket path for "socket", host:port for "tcp", API server URL for "kubernetes" */
  url: string
  created_at: string
  /** TLS material for "tcp", encrypted at rest (see lib/server/crypto.ts). Null = plain HTTP. */
  tls_ca: string | null
  tls_cert: string | null
  tls_key: string | null
  /**
   * "kubernetes" only: bearer token and/or client certificate plus the CA,
   * as encrypted JSON (lib/server/kubernetes/target.ts).
   */
  kube_credentials: string | null
  /** "kubernetes" only: namespace preselected on list pages and for Apply. */
  kube_namespace: string | null
  /** "kubernetes" only: 1 = don't verify the API server's certificate. */
  kube_insecure: Generated<number>
}

/** Environments a standard user may see and use, with their role there. Admins can use all of them. */
export interface EnvironmentAccessTable {
  user_id: number
  environment_id: number
  created_at: string
  role: Generated<EnvironmentRole>
}

/** One-time two-factor recovery codes (SHA-256 hashes). */
export interface RecoveryCodesTable {
  id: Generated<number>
  user_id: number
  code_hash: string
  used_at: string | null
  created_at: string
}

/** Personal API tokens (SHA-256 hashes; the token is only shown once). */
export interface ApiTokensTable {
  id: Generated<number>
  user_id: number
  name: string
  token_hash: string
  prefix: string
  created_at: string
  expires_at: string | null
  last_used_at: string | null
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

/** Git source of a stack (lib/server/stacks/git-records.ts); stacks without a row are edited in Gantry. */
export interface StackGitTable {
  stack_id: number
  /** https URL without credentials */
  repo_url: string
  /** Branch, tag or full commit id */
  ref: string
  /** Compose file relative to the repository root */
  compose_path: string
  /** Encrypted JSON {username, token}, null for public repositories */
  credentials: string | null
  /** Last successfully deployed commit */
  commit_sha: string | null
  commit_subject: string | null
  commit_author: string | null
  /** ISO author date */
  commit_date: string | null
  /** sha256 of commit, .env and compose path at the last successful deploy */
  deployed_hash: string | null
  /** Opaque id in the webhook URL; null = webhook disabled */
  webhook_id: string | null
  /** Encrypted webhook secret */
  webhook_secret: string | null
  /** Check for new commits every N minutes; 0 = off */
  poll_minutes: Generated<number>
  last_checked_at: string | null
  created_at: string
  updated_at: string
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

/** Helm chart repository (https index or oci:// registry) for Kubernetes environments. */
export interface HelmRepositoriesTable {
  id: Generated<number>
  /** Name helm knows it by; charts are "<name>/<chart>". */
  name: string
  /** https://… (or http://) index repository, or oci://host/path */
  url: string
  /** Encrypted JSON {username, password} (lib/server/crypto.ts); null = anonymous */
  credentials: string | null
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
  stack_git: StackGitTable
  metrics: MetricsTable
  registries: RegistriesTable
  templates: TemplatesTable
  notification_channels: NotificationChannelsTable
  alerts: AlertsTable
  auto_update_rules: AutoUpdateRulesTable
  settings: SettingsTable
  proxy_settings: ProxySettingsTable
  proxy_hosts: ProxyHostsTable
  recovery_codes: RecoveryCodesTable
  api_tokens: ApiTokensTable
  helm_repositories: HelmRepositoriesTable
}

export type User = Selectable<UsersTable>
export type NewUser = Insertable<UsersTable>
export type Environment = Selectable<EnvironmentsTable>
export type AuditLog = Selectable<AuditLogsTable>
export type Stack = Selectable<StacksTable>
export type StackGit = Selectable<StackGitTable>
export type Metric = Selectable<MetricsTable>
export type NewMetric = Insertable<MetricsTable>
export type Registry = Selectable<RegistriesTable>
export type CustomTemplate = Selectable<TemplatesTable>
