"use server"

import crypto from "node:crypto"
import { redirect } from "next/navigation"
import { z } from "zod"

import { customTemplateId, customTemplateKey, checkVariables, generatePassword, mergeVariables, renderDotenv, templateDefaultsFromEnv } from "@/lib/templates"
import { ENVIRONMENT_FIELD } from "@/lib/permissions"
import { expectedEnvironment, inEnvironment, runAction, UserError } from "@/lib/server/action"
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
  const key = String(formData.get("template") ?? "")
  const template = await getTemplate(key)
  if (!template) return { error: "Template not found" }

  const submitted: Record<string, string> = {}
  for (const v of template.variables) submitted[v.name] = String(formData.get(`var:${v.name}`) ?? "")
  // Echo back what was typed (generated passwords are created on the server and not echoed).
  const values: Record<string, string> = { name: String(formData.get("name") ?? "") }
  for (const v of template.variables) values[`var:${v.name}`] = submitted[v.name]

  const fieldErrors: Record<string, string[]> = {}
  const name = stackNameSchema.safeParse(values.name)
  if (!name.success) fieldErrors.name = [name.error.issues[0]?.message ?? "Invalid name"]
  const check = checkVariables(template.variables, submitted, () => generatePassword(randomBytes))
  for (const [k, msg] of Object.entries(check.errors)) fieldErrors[`var:${k}`] = [msg]
  if (!name.success || Object.keys(fieldErrors).length) {
    return { error: "Please fix the highlighted fields", fieldErrors, values }
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
    return `Stack ${name.data} created`
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

const templateSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(100),
  description: z.string().trim().max(500, "At most 500 characters"),
  category: z.string().trim().max(64).transform((v) => v || "Custom"),
  stack_name: stackNameSchema,
})

/** Validates the template form; returns normalized values or field errors. */
function checkTemplate(formData: FormData) {
  const values = formValues(formData, TEMPLATE_FIELDS)
  const parsed = templateSchema.safeParse(values)
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
      fieldErrors.compose = [`Rename ${reserved.join(", ")}: docker compose would take ${reserved.length > 1 ? "them" : "it"} from Gantry's environment, not from .env`]
    }
  }
  if (!parsed.success || Object.keys(fieldErrors).length) {
    return { state: { error: "Please fix the highlighted fields", fieldErrors, values } as ActionState }
  }
  return { data: { ...parsed.data, compose, env }, values }
}

export async function createTemplate(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const checked = checkTemplate(formData)
  if (checked.state) return checked.state
  const { data, values } = checked

  let id = 0
  const res = await runAction("admin", "template.create", data.title, async ({ user }) => {
    if (await findCustomTemplateByTitle(data.title)) throw new UserError(`A template called "${data.title}" already exists`)
    id = await insertTemplate({ ...data, created_by: user.username })
    return `Template ${data.title} saved`
  })
  if (!res.ok) return { ...res, values }
  redirect(`/templates/${customTemplateKey(id)}`)
}

export async function updateTemplate(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const id = customTemplateId(String(formData.get("template") ?? ""))
  if (id === null) return { error: "Only custom templates can be edited" }
  const checked = checkTemplate(formData)
  if (checked.state) return checked.state
  const { data, values } = checked

  const res = await runAction("admin", "template.update", data.title, async () => {
    if (!(await getCustomTemplate(id))) throw new UserError("Template not found")
    const other = await findCustomTemplateByTitle(data.title)
    if (other && other.id !== id) throw new UserError(`A template called "${data.title}" already exists`)
    await updateTemplateRecord(id, data)
    return `Template ${data.title} saved`
  })
  if (!res.ok) return { ...res, values }
  redirect(`/templates/${customTemplateKey(id)}`)
}

export async function deleteTemplate(key: string): Promise<ActionState> {
  const id = customTemplateId(key)
  if (id === null) return { error: "Built-in templates can't be deleted" }
  const title = (await getCustomTemplate(id))?.title ?? key
  return runAction("admin", "template.delete", title, async () => {
    await deleteTemplateRecord(id)
    return `Template ${title} deleted`
  })
}

/**
 * Saves a stack's compose file as a custom template; secret-looking .env
 * values are left out. `href` is the new template's page.
 */
export async function saveStackAsTemplate(stackId: number): Promise<ActionState & { href?: string }> {
  const parsed = z.number().int().positive().safeParse(stackId)
  if (!parsed.success) return { error: "Invalid stack" }

  let id = 0
  const res = await runAction("admin", "template.create", `stack #${parsed.data}`, async ({ user }) => {
    const stack = await getStack(parsed.data)
    const env = await getCurrentEnvironment()
    if (!stack || stack.environment_id !== env?.id) throw new UserError("Stack not found in this environment")
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
    return `Saved as template ${title}`
  })
  return res.ok ? { ...res, href: `/templates/${customTemplateKey(id)}` } : res
}
