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

export interface Database {
  users: UsersTable
  environments: EnvironmentsTable
  audit_logs: AuditLogsTable
  stacks: StacksTable
}

export type User = Selectable<UsersTable>
export type NewUser = Insertable<UsersTable>
export type Environment = Selectable<EnvironmentsTable>
export type AuditLog = Selectable<AuditLogsTable>
export type Stack = Selectable<StacksTable>
