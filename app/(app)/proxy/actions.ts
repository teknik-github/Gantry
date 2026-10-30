"use server"

import { z } from "zod"

import { checkHost, checkSettings } from "@/lib/proxy"
import { runAction, UserError } from "@/lib/server/action"
import { getCurrentUser } from "@/lib/server/auth/dal"
import type { DockerApi } from "@/lib/server/docker/api"
import { getCurrentEnvironment } from "@/lib/server/environments"
import {
  applyProxy,
  deleteProxyHost,
  getProxySettings,
  listProxyHosts,
  saveProxyHost,
  saveProxySettings,
} from "@/lib/server/proxy"
import type { ActionState } from "@/lib/validation"

const idSchema = z.coerce.number().int().positive()

async function currentEnvironmentId() {
  const env = await getCurrentEnvironment()
  if (!env) throw new UserError("No Docker environment configured")
  return env.id
}

function fieldState(errors: Record<string, string>, values: Record<string, string>): ActionState {
  return {
    error: "Please fix the highlighted fields",
    fieldErrors: Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, [v]])),
    values,
  }
}

/** Applies the saved state; a failure becomes the action's error (the change itself is kept). */
async function applyOrExplain(api: DockerApi, environmentId: number, done: string) {
  try {
    const warnings = await applyProxy(api, environmentId)
    return warnings.length ? `${done}. Some containers couldn't be attached: ${warnings.join("; ")}` : done
  } catch (err) {
    throw new UserError(`${done}, but the proxy couldn't be updated: ${(err as Error).message}`)
  }
}

export async function saveSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const values: Record<string, string> = {}
  for (const k of ["mode", "httpPort", "httpsPort", "email", "externalNetwork"]) values[k] = String(formData.get(k) ?? "")
  const checked = checkSettings(values)
  if (!checked.settings) return fieldState(checked.errors, values)
  const settings = checked.settings
  return runAction("admin", "proxy.settings", settings.mode, async ({ docker }) => {
    const environmentId = await currentEnvironmentId()
    await saveProxySettings(environmentId, settings)
    const label = { off: "Proxy turned off", internal: "Built-in proxy configured", external: "External proxy configured" }[settings.mode]
    return applyOrExplain(await docker(), environmentId, label)
  })
}

export async function saveHost(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const field = (k: string) => String(formData.get(k) ?? "")
  const values = { domains: field("domains"), target: field("target"), port: field("port"), tls: field("tls") }
  const rawId = formData.get("id")
  const id = rawId ? idSchema.safeParse(rawId) : null
  if (id && !id.success) return { error: "Invalid host" }
  // Checking for duplicate domains reads the stored hosts: authorize first.
  if ((await getCurrentUser())?.role !== "admin") return { error: "Only administrators can do this." }
  const env = await getCurrentEnvironment()
  if (!env) return { error: "No Docker environment configured" }
  const others = await listProxyHosts(env.id)
  const checked = checkHost(values, others, id?.data)
  if (!checked.host) return fieldState(checked.errors, values)
  const host = { ...checked.host, enabled: formData.get("enabled") === "on" }

  return runAction("admin", id ? "proxy.host.update" : "proxy.host.create", host.domains.join(", "), async ({ docker }) => {
    if (id && !others.some((o) => o.id === id.data)) throw new UserError("Host not found")
    await saveProxyHost(env.id, host, id?.data)
    const { settings } = await getProxySettings(env.id)
    const done = `${host.domains[0]} saved`
    if (settings.mode === "off") return `${done}. Turn the proxy on to serve it.`
    return applyOrExplain(await docker(), env.id, done)
  })
}

export async function setHostEnabled(id: number, enabled: boolean): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid host" }
  return runAction("admin", enabled ? "proxy.host.enable" : "proxy.host.disable", `#${parsed.data}`, async ({ docker }) => {
    const environmentId = await currentEnvironmentId()
    const host = (await listProxyHosts(environmentId)).find((h) => h.id === parsed.data)
    if (!host) throw new UserError("Host not found")
    await saveProxyHost(environmentId, { ...host, enabled: enabled === true }, host.id)
    const { settings } = await getProxySettings(environmentId)
    const done = `${host.domains[0]} ${enabled ? "enabled" : "disabled"}`
    return settings.mode === "off" ? done : applyOrExplain(await docker(), environmentId, done)
  })
}

export async function deleteHost(id: number): Promise<ActionState> {
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: "Invalid host" }
  return runAction("admin", "proxy.host.delete", `#${parsed.data}`, async ({ docker }) => {
    const environmentId = await currentEnvironmentId()
    await deleteProxyHost(environmentId, parsed.data)
    const { settings } = await getProxySettings(environmentId)
    return settings.mode === "off" ? "Host removed" : applyOrExplain(await docker(), environmentId, "Host removed")
  })
}

/** Re-applies the configuration (e.g. after the proxy container was removed by hand). */
export async function reapplyProxy(): Promise<ActionState> {
  return runAction("admin", "proxy.apply", "manual", async ({ docker }) => {
    const environmentId = await currentEnvironmentId()
    return applyOrExplain(await docker(), environmentId, "Proxy configuration applied")
  })
}
