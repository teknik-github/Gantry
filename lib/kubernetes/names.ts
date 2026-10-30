import { z } from "zod"

// Kubernetes naming rules shared by Server Actions, pages and forms.

/** DNS-1123 label: namespaces, services. */
export const DNS_LABEL_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/

/** DNS-1123 subdomain: most object names (deployments, pods, configmaps, ...). */
export const DNS_SUBDOMAIN_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/

export const namespaceSchema = z
  .string()
  .trim()
  .min(1, "Namespace is required")
  .max(63, "At most 63 characters")
  .regex(DNS_LABEL_RE, "Lowercase letters, digits and '-', starting and ending with a letter or digit")

export const objectNameSchema = z.string().min(1).max(253).regex(DNS_SUBDOMAIN_RE, "Invalid object name")

/** Namespaces Gantry refuses to delete: removing them breaks the cluster. */
export const PROTECTED_NAMESPACES = new Set(["default", "kube-system", "kube-public", "kube-node-lease"])

export const WORKLOAD_KINDS = ["Deployment", "StatefulSet", "DaemonSet"] as const
export type WorkloadKind = (typeof WORKLOAD_KINDS)[number]

/** Upper bound for the scale dialog; more is almost certainly a typo. */
export const MAX_REPLICAS = 1000
