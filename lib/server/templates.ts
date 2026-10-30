import "server-only"

import { builtinTemplate, BUILTIN_TEMPLATES } from "@/lib/template-catalog"
import { customTemplateId, customTemplateKey, mergeVariables, type Template } from "@/lib/templates"
import { getDb } from "@/lib/server/db"
import type { CustomTemplate } from "@/lib/server/db/schema"

function toTemplate(row: CustomTemplate): Template & { env: string; createdBy: string } {
  return {
    key: customTemplateKey(row.id),
    source: "custom",
    title: row.title,
    description: row.description,
    category: row.category,
    stackName: row.stack_name,
    compose: row.compose,
    env: row.env,
    createdBy: row.created_by,
    variables: mergeVariables([], row.compose, row.env),
  }
}

/** Built-in templates followed by custom ones. */
export async function listTemplates(): Promise<Template[]> {
  const db = await getDb()
  const rows = await db.selectFrom("templates").selectAll().orderBy("title").execute()
  return [...BUILTIN_TEMPLATES, ...rows.map(toTemplate)]
}

export async function getCustomTemplate(id: number) {
  const db = await getDb()
  const row = await db.selectFrom("templates").selectAll().where("id", "=", id).executeTakeFirst()
  return row ? toTemplate(row) : null
}

/** A template by URL key: a built-in slug or "c-<id>". */
export async function getTemplate(key: string) {
  const id = customTemplateId(key)
  return id === null ? builtinTemplate(key) : getCustomTemplate(id)
}

export async function findCustomTemplateByTitle(title: string) {
  const db = await getDb()
  return db.selectFrom("templates").select("id").where("title", "=", title).executeTakeFirst()
}

type TemplateValues = { title: string; description: string; category: string; stack_name: string; compose: string; env: string }

export async function insertTemplate(values: TemplateValues & { created_by: string }) {
  const db = await getDb()
  const now = new Date().toISOString()
  const res = await db.insertInto("templates").values({ ...values, created_at: now, updated_at: now }).executeTakeFirstOrThrow()
  return Number(res.insertId)
}

export async function updateTemplate(id: number, values: TemplateValues) {
  const db = await getDb()
  await db.updateTable("templates").set({ ...values, updated_at: new Date().toISOString() }).where("id", "=", id).execute()
}

export async function deleteTemplate(id: number) {
  const db = await getDb()
  await db.deleteFrom("templates").where("id", "=", id).execute()
}
