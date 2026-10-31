"use server"

import { z } from "zod"

import { getI18n } from "@/lib/i18n/server"
import { DNS_LABEL_RE, namespaceSchema, objectNameSchema } from "@/lib/kubernetes/names"
import { audit } from "@/lib/server/audit"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { ExecSessionError } from "@/lib/server/exec-sessions"
import { getKubeEnvironment, KubeError } from "@/lib/server/kubernetes"
import { openPodExecSession, POD_SHELLS, type PodShell } from "@/lib/server/kubernetes/exec"
import { kubeTarget } from "@/lib/server/kubernetes/target"

const execSchema = z.object({
  environmentId: z.number().int().positive(),
  namespace: namespaceSchema,
  pod: objectNameSchema,
  container: z.string().max(63).regex(DNS_LABEL_RE, "Invalid container"),
  shell: z.enum(Object.keys(POD_SHELLS) as [PodShell, ...PodShell[]]),
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(4).max(200),
})

/**
 * Opens an interactive shell in a pod's container (kubectl exec). Like a
 * Docker console it is full control of the container, so it is limited to
 * administrators and audited. Output and input go through /api/exec/:sid.
 */
export async function startPodExecSession(
  input: z.input<typeof execSchema>
): Promise<{ sid: string; error?: never } | { sid?: never; error: string }> {
  const { t } = await getI18n()
  const user = await getCurrentUser()
  if (!user) return { error: t.common.errors.sessionExpired }
  if (user.role !== "admin") return { error: t.kubernetes.actions.consoleAdminsOnly }

  const parsed = execSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? t.kubernetes.actions.invalidRequest }
  const v = parsed.data

  try {
    const env = await getKubeEnvironment(v.environmentId)
    const sid = await openPodExecSession({
      userId: user.id,
      environmentId: env.id,
      target: kubeTarget(env),
      namespace: v.namespace,
      pod: v.pod,
      container: v.container,
      command: POD_SHELLS[v.shell],
      cols: v.cols,
      rows: v.rows,
    })
    await audit(user, "kubernetes.exec", `${v.namespace}/${v.pod} ${v.container} ${v.shell}`)
    return { sid }
  } catch (err) {
    if (err instanceof KubeError || err instanceof ExecSessionError) return { error: err.message }
    console.error("[gantry] pod exec failed", err)
    return { error: t.kubernetes.actions.consoleFailed }
  }
}
