"use server"

import crypto from "node:crypto"
import { redirect } from "next/navigation"
import { z } from "zod"

import { customTemplateId, customTemplateKey, checkVariables, generatePassword, mergeVariables, renderDotenv, templateDefaultsFromEnv } from "@/lib/templates"
import { composeContainerName, composeServicePorts } from "@/lib/compose-ports"
import type { I18n } from "@/lib/i18n"
import { getI18n } from "@/lib/i18n/server"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { checkHost, type ProxyHost } from "@/lib/proxy"
import { authorize, expectedEnvironment, inEnvironment, runAction, UserError } from "@/lib/server/action"
import { audit } from "@/lib/server/audit"
import { applyProxy, getProxySettings, listProxyHosts, saveProxyHost } from "@/lib/server/proxy"
import { getStack } from "@/lib/server/stacks"
import { createStackInCurrentEnvironment } from "@/lib/server/stacks/create"
import {
  deleteTemplate as deleteTemplateRecord,
  findCustomTemplateByTitle,
  getCustomTemplate,
  getTemplate,
  insertTemplate,
  updateTemplate as updateTemplateRecord,
} from "@/lib/server/templates"
import { getCurrentEnvironment } from "@/lib/server/environments"
import { normalizeText, stackNameSchema, validateCompose, validateDotenv } from "@/lib/stacks"
import type { ActionState } from "@/lib/validation"

/** Variables docker compose takes from Gantry's own environment rather than .env. */
const RESERVED = new Set(["PATH", "HOME", "TZ", "LANG", "LC_ALL", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"])

const randomBytes = (bytes: Uint8Array) => crypto.getRandomValues(bytes)

function formValues(formData: FormData, keys: string[]) {
  const values: Record<string, string> = {}
  for (const k of keys) values[k] = String(formData.get(k) ?? "")
  return values
}

// ---------------------------------------------------------------- Deploy

export async function deployTemplate(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { t, format } = await getI18n()
  const key = String(formData.get("template") ?? "")
  const template = await getTemplate(key)
  if (!template) return { error: t.templates.messages.notFound }

  const submitted: Record<string, string> = {}
  for (const v of template.variables) submitted[v.name] = String(formData.get(`var:${v.name}`) ?? "")
  // Echo back what was typed (generated passwords are created on the server and not echoed).
  const values: Record<string, string> = { name: String(formData.get("name") ?? "") }
  for (const v of template.variables) values[`var:${v.name}`] = submitted[v.name]

  const fieldErrors: Record<string, string[]> = {}
  const name = stackNameSchema.safeParse(values.name)
  if (!name.success) fieldErrors.name = [name.error.issues[0]?.message ?? t.stacks.messages.invalidName]
  const check = checkVariables(template.variables, submitted, () => generatePassword(randomBytes))
  for (const [k, msg] of Object.entries(check.errors)) fieldErrors[`var:${k}`] = [msg]

  // Optional: serve one of the template's services under a domain through the proxy.
  for (const k of ["domains", "expose", "tls"]) values[k] = String(formData.get(k) ?? "")
  let expose: Omit<ProxyHost, "enabled"> | null = null
  let environmentId: number | null = null
  if (values.domains.trim() && name.success) {
    // Checking the domains reads the stored proxy hosts: authorize first (same scope as the deploy).
    const auth = await authorize(inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD))))
    if ("error" in auth) return { error: auth.error, values }
    const environment = auth.environment
    if (!environment) return { error: t.common.environment.noDockerConfigured }
    environmentId = environment.id
    const [service = "", port = ""] = values.expose.split(":")
    const known = composeServicePorts(template.compose).some((p) => p.service === service && String(p.port) === port)
    if (!known) fieldErrors.expose = [t.templates.messages.pickExpose]
    else {
      const checked = checkHost(
        { domains: values.domains, target: composeContainerName(name.data, service), port, tls: values.tls },
        await listProxyHosts(environment.id)
      )
      for (const [k, msg] of Object.entries(checked.errors)) fieldErrors[k === "target" || k === "port" ? "expose" : k] = [msg]
      expose = checked.host ?? null
    }
  }
  if (!name.success || Object.keys(fieldErrors).length) {
    return { error: t.common.errors.fixFields, fieldErrors, values }
  }

  const env = renderDotenv(template.variables, check.values)
  let createdId = 0
  // Deploying is a stack in the current environment: managers can; editing templates is global (admins).
  const scope = inEnvironment("manage", expectedEnvironment(formData.get(ENVIRONMENT_FIELD)))
  const res = await runAction(scope, "template.deploy", `${template.title} → ${name.data}`, async (ctx) => {
    createdId = await createStackInCurrentEnvironment(ctx, {
      name: name.data,
      compose: template.compose,
      env,
      deploy: true,
    })
    if (expose && environmentId) {
      await saveProxyHost(environmentId, { ...expose, enabled: true })
      await audit(ctx.user, "proxy.host.create", expose.domains.join(", "))
      const { settings } = await getProxySettings(environmentId)
      if (settings.mode !== "off") {
        // The stack is up either way; a proxy problem shows on the Proxy page.
        await applyProxy(await ctx.docker(), environmentId).catch((err) =>
          console.warn(`[gantry] proxy update after deploying ${name.data} failed: ${(err as Error).message}`)
        )
      }
    }
    return format(t.stacks.messages.created, { name: name.data })
  })
  if (!res.ok) {
    const nameTaken = res.error && /already exists/.test(res.error)
    return { ...res, fieldErrors: nameTaken ? { name: [res.error!] } : undefined, values }
  }
  // The stack page shows the deploy output (successful or not).
  redirect(`/stacks/${createdId}`)
}

// ---------------------------------------------------------------- Custom templates

const TEMPLATE_FIELDS = ["title", "description", "category", "stack_name", "compose", "env"]

function templateSchema(t: I18n["t"]) {
  return z.object({
    title: z.string().trim().min(1, t.templates.messages.titleRequired).max(100),
    description: z.string().trim().max(500, t.templates.messages.descriptionTooLong),
    category: z.string().trim().max(64).transform((v) => v || "Custom"),
    stack_name: stackNameSchema,
  })
}

/** Validates the template form; returns normalized values or field errors. */
function checkTemplate(formData: FormData, i18n: I18n) {
  const { t } = i18n
  const values = formValues(formData, TEMPLATE_FIELDS)
  const parsed = templateSchema(t).safeParse(values)
  const fieldErrors: Record<string, string[]> = {}
  if (!parsed.success) {
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= [issue.message]
  }
  const compose = normalizeText(values.compose)
  const env = normalizeText(values.env)
  const composeCheck = validateCompose(compose)
  if (!composeCheck.ok) fieldErrors.compose = [composeCheck.error]
  const envError = validateDotenv(env)
  if (envError) fieldErrors.env = [envError]
  if (composeCheck.ok && !envError) {
    const reserved = mergeVariables([], compose, env).filter((v) => RESERVED.has(v.name)).map((v) => v.name)
    if (reserved.length) {
      fieldErrors.compose = [i18n.plural(t.templates.messages.reserved, reserved.length, { names: reserved.join(", ") })]
    }
  }
  if (!parsed.success || Object.keys(fieldErrors).length) {
    return { state: { error: t.common.errors.fixFields, fieldErrors, values } as ActionState }
  }
  return { data: { ...parsed.data, compose, env }, values }
}

export async function createTemplate(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const i18n = await getI18n()
  const { t, format } = i18n
  const checked = checkTemplate(formData, i18n)
  if (checked.state) return checked.state
  const { data, values } = checked

  let id = 0
  const res = await runAction("admin", "template.create", data.title, async ({ user }) => {
    if (await findCustomTemplateByTitle(data.title)) throw new UserError(format(t.templates.messages.exists, { title: data.title }))
    id = await insertTemplate({ ...data, created_by: user.username })
    return format(t.templates.messages.saved, { title: data.title })
  })
  if (!res.ok) return { ...res, values }
  redirect(`/templates/${customTemplateKey(id)}`)
}

export async function updateTemplate(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const i18n = await getI18n()
  const { t, format } = i18n
  const id = customTemplateId(String(formData.get("template") ?? ""))
  if (id === null) return { error: t.templates.messages.onlyCustomEditable }
  const checked = checkTemplate(formData, i18n)
  if (checked.state) return checked.state
  const { data, values } = checked

  const res = await runAction("admin", "template.update", data.title, async () => {
    if (!(await getCustomTemplate(id))) throw new UserError(t.templates.messages.notFound)
    const other = await findCustomTemplateByTitle(data.title)
    if (other && other.id !== id) throw new UserError(format(t.templates.messages.exists, { title: data.title }))
    await updateTemplateRecord(id, data)
    return format(t.templates.messages.saved, { title: data.title })
  })
  if (!res.ok) return { ...res, values }
  redirect(`/templates/${customTemplateKey(id)}`)
}

export async function deleteTemplate(key: string): Promise<ActionState> {
  const { t, format } = await getI18n()
  const id = customTemplateId(key)
  if (id === null) return { error: t.templates.messages.builtinNotDeletable }
  const title = (await getCustomTemplate(id))?.title ?? key
  return runAction("admin", "template.delete", title, async () => {
    await deleteTemplateRecord(id)
    return format(t.templates.messages.deleted, { title })
  })
}

/**
 * Saves a stack's compose file as a custom template; secret-looking .env
 * values are left out. `href` is the new template's page.
 */
export async function saveStackAsTemplate(stackId: number): Promise<ActionState & { href?: string }> {
  const { t, format } = await getI18n()
  const parsed = z.number().int().positive().safeParse(stackId)
  if (!parsed.success) return { error: t.stacks.messages.invalidStack }

  let id = 0
  const res = await runAction("admin", "template.create", `stack #${parsed.data}`, async ({ user }) => {
    const stack = await getStack(parsed.data)
    const env = await getCurrentEnvironment()
    if (!stack || stack.environment_id !== env?.id) throw new UserError(t.templates.messages.stackNotFound)
    let title = stack.name
    for (let n = 2; await findCustomTemplateByTitle(title); n++) title = `${stack.name} (${n})`
    id = await insertTemplate({
      title,
      description: `Saved from stack ${stack.name}`,
      category: "Custom",
      stack_name: stack.name,
      compose: stack.compose,
      env: normalizeText(templateDefaultsFromEnv(stack.env)),
      created_by: user.username,
    })
    return format(t.templates.messages.savedAsTemplate, { title })
  })
  return res.ok ? { ...res, href: `/templates/${customTemplateKey(id)}` } : res
}
