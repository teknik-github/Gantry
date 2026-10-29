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

export interface Database {
  users: UsersTable
  environments: EnvironmentsTable
  audit_logs: AuditLogsTable
  metrics: MetricsTable
}

export type User = Selectable<UsersTable>
export type NewUser = Insertable<UsersTable>
export type Environment = Selectable<EnvironmentsTable>
export type AuditLog = Selectable<AuditLogsTable>
export type Metric = Selectable<MetricsTable>
export type NewMetric = Insertable<MetricsTable>
