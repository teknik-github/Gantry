"use server"

import { z } from "zod"

import type { I18n } from "@/lib/i18n"
import { getI18n } from "@/lib/i18n/server"
import { checkHost, checkSettings } from "@/lib/proxy"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { authorize, expectedEnvironment, inEnvironment, runAction, UserError } from "@/lib/server/action"
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
  if (!env) throw new UserError((await getI18n()).t.common.environment.noDockerConfigured)
  return env.id
}

/** The English field errors of lib/proxy.ts (checkHost / checkSettings) in the user's language. */
function localizeFieldError({ t, format }: I18n, message: string): string {
  const e = t.proxy.fieldErrors
  const listed = (prefix: string) => (message.startsWith(prefix) ? message.slice(prefix.length) : null)
  const invalid = listed("Not a valid domain: ")
  if (invalid !== null) return format(e.invalidDomain, { domains: invalid })
  const taken = listed("Already used by another host: ")
  if (taken !== null) return format(e.domainTaken, { domains: taken })
  const known: Record<string, string> = {
    "Add at least one domain": e.noDomain,
    "At most 20 domains per host": e.tooManyDomains,
    "Pick a TLS mode": e.pickTls,
    "Let's Encrypt needs public domains (no wildcards or .local/.lan/.localhost); use Self-signed": e.letsEncryptPublic,
    "Pick a container": e.pickContainer,
    "Pick a mode": e.pickMode,
    "Must differ from the HTTP port": e.samePort,
    "Not a valid email": e.invalidEmail,
    "The Docker network your proxy is attached to": e.network,
  }
  return known[message] ?? message
}

function fieldState(i18n: I18n, errors: Record<string, string>, values: Record<string, string>): ActionState {
  return {
    error: i18n.t.common.errors.fixFields,
    fieldErrors: Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, [localizeFieldError(i18n, v)]])),
    values,
  }
}

/** Applies the saved state; a failure becomes the action's error (the change itself is kept). */
async function applyOrExplain(api: DockerApi, environmentId: number, done: string) {
  const { t, format } = await getI18n()
  try {
    const warnings = await applyProxy(api, environmentId)
    return warnings.length ? format(t.proxy.errors.notAttached, { done, warnings: warnings.join("; ") }) : done
  } catch (err) {
    throw new UserError(format(t.proxy.errors.notUpdated, { done, message: (err as Error).message }))
  }
}

export async function saveSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const i18n = await getI18n()
  const { t } = i18n
  const values: Record<string, string> = {}
  for (const k of ["mode", "httpPort", "httpsPort", "email", "externalNetwork"]) values[k] = String(formData.get(k) ?? "")
  const checked = checkSettings(values)
  if (!checked.settings) return fieldState(i18n, checked.errors, values)
  const settings = checked.settings
  return runAction(inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD))), "proxy.settings", settings.mode, async ({ docker }) => {
    const environmentId = await currentEnvironmentId()
    await saveProxySettings(environmentId, settings)
    const label = { off: t.proxy.turnedOff, internal: t.proxy.internalConfigured, external: t.proxy.externalConfigured }[settings.mode]
    return applyOrExplain(await docker(), environmentId, label)
  })
}

export async function saveHost(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const i18n = await getI18n()
  const { t, format } = i18n
  const field = (k: string) => String(formData.get(k) ?? "")
  const values = { domains: field("domains"), target: field("target"), port: field("port"), tls: field("tls") }
  const rawId = formData.get("id")
  const id = rawId ? idSchema.safeParse(rawId) : null
  if (id && !id.success) return { error: t.proxy.errors.invalidHost }
  // Checking for duplicate domains reads the stored hosts: authorize first.
  const scope = inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD)))
  const auth = await authorize(scope)
  if ("error" in auth) return { error: auth.error }
  const env = auth.environment
  if (!env) return { error: t.common.environment.noDockerConfigured }
  const others = await listProxyHosts(env.id)
  const checked = checkHost(values, others, id?.data)
  if (!checked.host) return fieldState(i18n, checked.errors, values)
  const host = { ...checked.host, enabled: formData.get("enabled") === "on" }

  return runAction(scope, id ? "proxy.host.update" : "proxy.host.create", host.domains.join(", "), async ({ docker }) => {
    if (id && !others.some((o) => o.id === id.data)) throw new UserError(t.proxy.errors.hostNotFound)
    await saveProxyHost(env.id, host, id?.data)
    const { settings } = await getProxySettings(env.id)
    const done = format(t.proxy.saved, { domain: host.domains[0] })
    if (settings.mode === "off") return format(t.proxy.savedOff, { done })
    return applyOrExplain(await docker(), env.id, done)
  })
}

export async function setHostEnabled(id: number, enabled: boolean, environmentId?: number): Promise<ActionState> {
  const { t, format } = await getI18n()
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: t.proxy.errors.invalidHost }
  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), enabled ? "proxy.host.enable" : "proxy.host.disable", `#${parsed.data}`, async ({ docker }) => {
    const environmentId = await currentEnvironmentId()
    const host = (await listProxyHosts(environmentId)).find((h) => h.id === parsed.data)
    if (!host) throw new UserError(t.proxy.errors.hostNotFound)
    await saveProxyHost(environmentId, { ...host, enabled: enabled === true }, host.id)
    const { settings } = await getProxySettings(environmentId)
    const done = format(enabled ? t.proxy.enabled : t.proxy.disabled, { domain: host.domains[0] })
    return settings.mode === "off" ? done : applyOrExplain(await docker(), environmentId, done)
  })
}

export async function deleteHost(id: number, environmentId?: number): Promise<ActionState> {
  const { t } = await getI18n()
  const parsed = idSchema.safeParse(id)
  if (!parsed.success) return { error: t.proxy.errors.invalidHost }
  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "proxy.host.delete", `#${parsed.data}`, async ({ docker }) => {
    const environmentId = await currentEnvironmentId()
    await deleteProxyHost(environmentId, parsed.data)
    const { settings } = await getProxySettings(environmentId)
    return settings.mode === "off" ? t.proxy.removed : applyOrExplain(await docker(), environmentId, t.proxy.removed)
  })
}

/** Re-applies the configuration (e.g. after the proxy container was removed by hand). */
export async function reapplyProxy(environmentId?: number): Promise<ActionState> {
  const { t } = await getI18n()
  return runAction(inEnvironment("manage", expectedEnvironment(environmentId)), "proxy.apply", "manual", async ({ docker }) => {
    const environmentId = await currentEnvironmentId()
    return applyOrExplain(await docker(), environmentId, t.proxy.applied)
  })
}
