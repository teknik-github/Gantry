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

export interface Database {
  users: UsersTable
  environments: EnvironmentsTable
  environment_access: EnvironmentAccessTable
  audit_logs: AuditLogsTable
}

export type User = Selectable<UsersTable>
export type NewUser = Insertable<UsersTable>
export type Environment = Selectable<EnvironmentsTable>
export type AuditLog = Selectable<AuditLogsTable>
