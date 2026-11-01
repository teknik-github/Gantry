"use server"

import { cookies } from "next/headers"
import { refresh } from "next/cache"
import { z } from "zod"

import type { I18n } from "@/lib/i18n"
import { getI18n } from "@/lib/i18n/server"
import { runAction, UserError } from "@/lib/server/action"
import { disconnectAgent } from "@/lib/server/agent/hub"
import { getCurrentUser } from "@/lib/server/auth/dal"
import { ENV_COOKIE } from "@/lib/server/auth/token"
import { getDb } from "@/lib/server/db"
import { docker } from "@/lib/server/docker/api"
import type { DockerTarget, DockerTls } from "@/lib/server/docker/client"
import { closeUserExecSessions } from "@/lib/server/docker/exec"
import { parseGrants, setEnvironmentUsers } from "@/lib/server/environment-access"
import { decryptTls, encryptTls, parseTls } from "@/lib/server/environment-target"
import { listEnvironments } from "@/lib/server/environments"
import { kube } from "@/lib/server/kubernetes/api"
import { KubeError, type KubeTarget } from "@/lib/server/kubernetes/client"
import { parseKubeconfig, parseTokenConnection, type KubeConnection } from "@/lib/server/kubernetes/connection"
import { encryptKubeCredentials, kubeTarget } from "@/lib/server/kubernetes/target"
import { namespaceSchema } from "@/lib/kubernetes/names"
import { fieldErrors, type ActionState } from "@/lib/validation"

const idSchema = z.number().int().positive()

export async function selectEnvironment(id: number): Promise<ActionState> {
  const { t } = await getI18n()
  const m = t.environments.messages
  const user = await getCurrentUser()
  if (!user) return { error: t.common.errors.sessionExpired }
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: m.invalid }

  // Only environments this user may use; others look like they don't exist.
  const env = (await listEnvironments()).find((e) => e.id === parsed.data)
  if (!env) return { error: m.notFound }

  ;(await cookies()).set(ENV_COOKIE, String(env.id), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  })
  refresh()
  return { ok: true }
}

const PEM_MAX = 64 * 1024

type Messages = I18n["t"]["environments"]["messages"]

const envSchema = (m: Messages) =>
  z
    .object({
      name: z.string().trim().min(1, m.nameRequired).max(100),
      // "agent" environments are added with createAgentEnvironment (agent-actions.ts); here only renamed.
      type: z.enum(["socket", "tcp", "agent", "kubernetes"]),
      // Docker only; Kubernetes uses kube_server or the kubeconfig.
      url: z.string().trim().max(255).default(""),
      // "on" when the TLS switch is enabled (tcp only).
      tls: z.enum(["on"]).optional(),
      // Edit form: "on" when new PEM material is supplied for an environment that already has TLS.
      tls_replace: z.enum(["on"]).optional(),
      tls_ca: z.string().max(PEM_MAX, m.tooLong).default(""),
      tls_cert: z.string().max(PEM_MAX, m.tooLong).default(""),
      tls_key: z.string().max(PEM_MAX, m.tooLong).default(""),
      // Kubernetes: "token" (server + token + CA) or "kubeconfig".
      kube_mode: z.enum(["token", "kubeconfig"]).default("token"),
      // Edit form: "on" when the connection (server, credentials) is entered again.
      kube_replace: z.enum(["on"]).optional(),
      kube_server: z.string().max(1024).default(""),
      kube_token: z.string().max(PEM_MAX, m.tooLong).default(""),
      kube_ca: z.string().max(PEM_MAX, m.tooLong).default(""),
      kube_insecure: z.enum(["on"]).optional(),
      kube_namespace: z.string().max(253).default(""),
      kubeconfig: z.string().max(256 * 1024, m.kubeconfigTooLarge).default(""),
      kube_context: z.string().max(253).default(""),
    })
    .superRefine((v, ctx) => {
      if (v.type === "agent") return
      if (v.type !== "kubernetes" && !v.url) {
        ctx.addIssue({ code: "custom", path: ["url"], message: m.addressRequired })
        return
      }
      if (v.type === "socket" && !v.url.startsWith("/")) {
        ctx.addIssue({ code: "custom", path: ["url"], message: m.socketPath })
      }
      if (v.type === "tcp" && !/^((tcp|http|https):\/\/)?[a-zA-Z0-9.-]+:\d{1,5}$/.test(v.url)) {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: v.tls ? m.hostPortTls : m.hostPort,
        })
      }
    })

type EnvInput = z.infer<ReturnType<typeof envSchema>>

function parseForm(formData: FormData, m: Messages) {
  const raw: Record<string, FormDataEntryValue> = {}
  for (const [k, v] of formData) if (typeof v === "string") raw[k] = v
  return envSchema(m).safeParse(raw)
}

/** New TLS material from the form, or a field error. Never echoes the key back. */
function tlsFromForm(v: EnvInput, m: Messages): { tls: DockerTls } | { state: ActionState } {
  const parsed = parseTls({ ca: v.tls_ca, cert: v.tls_cert, key: v.tls_key })
  if (parsed.errors) return { state: { error: m.fixTls, fieldErrors: parsed.errors } }
  return { tls: parsed.tls }
}

/** The Kubernetes connection entered in the form (token fields or a kubeconfig), or field errors. */
function kubeFromForm(v: EnvInput, t: I18n["t"]): { connection: KubeConnection } | { state: ActionState } {
  const res =
    v.kube_mode === "kubeconfig"
      ? parseKubeconfig(v.kubeconfig, v.kube_context, v.kube_namespace)
      : parseTokenConnection({
          server: v.kube_server,
          token: v.kube_token,
          ca: v.kube_ca,
          insecure: Boolean(v.kube_insecure),
          namespace: v.kube_namespace,
        })
  if (res.errors) return { state: { error: t.common.errors.fixFields, fieldErrors: res.errors } }
  return { connection: res.connection }
}

/** Refuse to save a cluster we cannot talk to: checks the version and that the credentials are accepted. */
async function verifyKube(target: KubeTarget, i18n: I18n) {
  const api = kube(target)
  try {
    const version = await api.version()
    await api.checkAccess()
    return version.gitVersion
  } catch (err) {
    if (err instanceof KubeError) throw new UserError(i18n.format(i18n.t.environments.messages.couldNotConnect, { error: err.message }))
    throw err
  }
}

function connectionTarget(connection: KubeConnection): KubeTarget {
  return { server: connection.server, ...connection.credentials, insecure: connection.insecure }
}

function kubeColumns(connection: KubeConnection) {
  return {
    url: connection.server,
    kube_credentials: encryptKubeCredentials(connection.credentials),
    kube_insecure: connection.insecure ? 1 : 0,
    kube_namespace: connection.namespace,
  }
}

/** Refuse to save an endpoint we cannot talk to. */
async function ping(target: DockerTarget, i18n: I18n) {
  try {
    await docker(target).ping()
  } catch (err) {
    throw new UserError(i18n.format(i18n.t.environments.messages.couldNotConnect, { error: (err as Error).message }))
  }
}

export async function createEnvironment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const i18n = await getI18n()
  const { t, format } = i18n
  const m = t.environments.messages
  const parsed = parseForm(formData, m)
  if (!parsed.success) return fieldErrors(parsed.error)
  const v = parsed.data
  if (v.type === "agent") return { error: m.useAddAgent }

  if (v.type === "kubernetes") {
    const res = kubeFromForm(v, t)
    if ("state" in res) return res.state
    const { connection } = res
    const how = connection.credentials.token ? "token" : "client certificate"
    return runAction("admin", "environment.create", `${v.name} (kubernetes, ${how})`, async () => {
      await verifyKube(connectionTarget(connection), i18n)
      const db = await getDb()
      // No grants: only administrators can use a new environment until access is given.
      await db
        .insertInto("environments")
        .values({ name: v.name, type: "kubernetes", ...kubeColumns(connection), created_at: new Date().toISOString() })
        .execute()
      return format(m.added, { name: v.name })
    })
  }

  const type = v.type
  let tls: DockerTls | null = null
  if (type === "tcp" && v.tls) {
    const res = tlsFromForm(v, m)
    if ("state" in res) return res.state
    tls = res.tls
  }

  return runAction("admin", "environment.create", `${v.name}${tls ? " (tls)" : ""}`, async () => {
    await ping({ type, url: v.url, tls }, i18n)
    const db = await getDb()
    // No grants: only administrators can use a new environment until access is given.
    await db
      .insertInto("environments")
      .values({ name: v.name, type, url: v.url, ...encryptTls(tls), created_at: new Date().toISOString() })
      .execute()
    return format(m.added, { name: v.name })
  })
}

export async function updateEnvironment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const i18n = await getI18n()
  const { format } = i18n
  const m = i18n.t.environments.messages
  const id = idSchema.safeParse(Number(formData.get("id")))
  if (!id.success) return { error: m.invalid }
  const parsed = parseForm(formData, m)
  if (!parsed.success) return fieldErrors(parsed.error)
  const v = parsed.data

  if (v.type === "kubernetes") return updateKubeEnvironment(id.data, v, i18n)
  if (v.type === "agent") return renameAgentEnvironment(id.data, v.name, i18n)
  const type = v.type

  // TLS: "keep" the stored certificates, "set" new ones, or "off" (sockets,
  // or the switch turned off).
  const useTls = v.type === "tcp" && Boolean(v.tls)
  let replacement: DockerTls | null = null
  if (useTls && v.tls_replace) {
    const res = tlsFromForm(v, m)
    if ("state" in res) return res.state
    replacement = res.tls
  }

  return runAction("admin", "environment.update", `${id.data}:${v.name}`, async () => {
    const db = await getDb()
    const existing = await db.selectFrom("environments").selectAll().where("id", "=", id.data).executeTakeFirst()
    if (!existing) throw new UserError(m.notFound)
    if (existing.type === "kubernetes") throw new UserError(m.kubernetesToDocker)
    if (existing.type === "agent") throw new UserError(m.agentToOther)

    let tls: DockerTls | null = null
    if (useTls) {
      tls = replacement ?? decryptTls(existing)
      if (!tls) throw new UserError(m.pasteTls)
    }

    await ping({ type, url: v.url, tls }, i18n)
    const tlsChanged = replacement !== null || (!useTls && existing.tls_key !== null)
    await db
      .updateTable("environments")
      .set({ name: v.name, type, url: v.url, ...(tlsChanged ? encryptTls(tls) : {}) })
      .where("id", "=", id.data)
      .execute()
    return format(m.saved, { name: v.name })
  })
}

/** Agent environments: only the name can be edited (the connection comes from the agent). */
async function renameAgentEnvironment(id: number, name: string, { format, t }: I18n): Promise<ActionState> {
  const m = t.environments.messages
  return runAction("admin", "environment.update", `${id}:${name}`, async () => {
    const db = await getDb()
    const existing = await db.selectFrom("environments").select("type").where("id", "=", id).executeTakeFirst()
    if (!existing) throw new UserError(m.notFound)
    if (existing.type !== "agent") throw new UserError(m.onlyAgent)
    await db.updateTable("environments").set({ name }).where("id", "=", id).execute()
    return format(m.saved, { name })
  })
}

/**
 * Kubernetes edit: name and default namespace, plus the connection when
 * "Replace" was used; otherwise the stored server and credentials are kept.
 */
async function updateKubeEnvironment(id: number, v: EnvInput, i18n: I18n): Promise<ActionState> {
  const { t, format } = i18n
  const m = t.environments.messages
  let replacement: KubeConnection | null = null
  let namespace: string | null = null
  if (v.kube_replace) {
    const res = kubeFromForm(v, t)
    if ("state" in res) return res.state
    replacement = res.connection
  } else if (v.kube_namespace.trim()) {
    const ns = namespaceSchema.safeParse(v.kube_namespace)
    if (!ns.success) return { error: t.common.errors.fixFields, fieldErrors: { kube_namespace: [ns.error.issues[0].message] } }
    namespace = ns.data
  }

  return runAction("admin", "environment.update", `${id}:${v.name}${replacement ? " (new connection)" : ""}`, async () => {
    const db = await getDb()
    const existing = await db.selectFrom("environments").selectAll().where("id", "=", id).executeTakeFirst()
    if (!existing) throw new UserError(m.notFound)
    if (existing.type !== "kubernetes") throw new UserError(m.dockerToKubernetes)

    if (replacement) {
      await verifyKube(connectionTarget(replacement), i18n)
      await db.updateTable("environments").set({ name: v.name, ...kubeColumns(replacement) }).where("id", "=", id).execute()
    } else {
      await verifyKube(kubeTarget(existing), i18n)
      await db.updateTable("environments").set({ name: v.name, kube_namespace: namespace }).where("id", "=", id).execute()
    }
    return format(m.saved, { name: v.name })
  })
}

export async function deleteEnvironment(id: number): Promise<ActionState> {
  const m = (await getI18n()).t.environments.messages
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: m.invalid }

  return runAction("admin", "environment.delete", String(id), async () => {
    const db = await getDb()
    const count = await db
      .selectFrom("environments")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow()
    if (Number(count.n) <= 1) throw new UserError(m.lastEnvironment)
    // environment_access rows go with it (ON DELETE CASCADE).
    await db.deleteFrom("environments").where("id", "=", parsed.data).execute()
    // Its key went with the row: a connected agent is dropped and can't come back.
    disconnectAgent(parsed.data, "the environment was deleted in Gantry")
    return m.removed
  })
}

/** Sets which standard users may use an environment, and their role ("user" values "<id>:<role>"). */
export async function setEnvironmentAccess(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const m = t.environments.messages
  const parsed = z.coerce.number().int().positive().safeParse(formData.get("id"))
  const grants = parseGrants(formData.getAll("user"))
  if (!parsed.success || !grants || grants.length > 10_000) return { error: m.invalidRequest }
  const id = parsed.data
  const summary = grants.map((g) => `${g.id}=${g.role}`).join(",") || "admins only"

  return runAction("admin", "environment.access", `${id}: ${summary}`, async () => {
    const db = await getDb()
    const env = await db.selectFrom("environments").select("name").where("id", "=", id).executeTakeFirst()
    if (!env) throw new UserError(m.notFound)
    const before = await db.selectFrom("environment_access").select("user_id").where("environment_id", "=", id).execute()
    await setEnvironmentUsers(db, id, grants)
    // Consoles need the manager role; affected users reopen them under the new grants.
    for (const uid of new Set([...before.map((r) => r.user_id), ...grants.map((g) => g.id)])) closeUserExecSessions(uid)
    return format(m.accessUpdated, { name: env.name })
  })
}
