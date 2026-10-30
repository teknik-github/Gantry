import { parseDotenv } from "@/lib/stacks"

// Stack templates: a compose file plus the variables it needs. Built-in ones
// ship with Gantry (lib/templates/catalog.ts); custom ones are stored in the
// database. Deploying a template creates a stack whose .env holds the values.

export type TemplateVariableType = "text" | "password" | "port"

export type TemplateVariable = {
  /** Variable name as used in the compose file: ${NAME}. */
  name: string
  label?: string
  description?: string
  default?: string
  /** "password": masked, generated when left empty. "port": 1-65535. */
  type?: TemplateVariableType
  required?: boolean
}

export type TemplateSource = "builtin" | "custom"

export type Template = {
  /** URL key: the slug for built-ins, "c-<id>" for custom templates. */
  key: string
  source: TemplateSource
  title: string
  description: string
  category: string
  compose: string
  variables: TemplateVariable[]
  /** Suggested stack name. */
  stackName: string
  website?: string
}

export const CUSTOM_PREFIX = "c-"

export function customTemplateKey(id: number) {
  return `${CUSTOM_PREFIX}${id}`
}

/** The id inside a custom template key, or null for built-in keys. */
export function customTemplateId(key: string): number | null {
  const m = /^c-([1-9][0-9]{0,9})$/.exec(key)
  return m ? Number(m[1]) : null
}

const VAR_RE = /\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}/g

/**
 * Variables a compose file interpolates (`${NAME}`, `${NAME:-default}`,
 * `${NAME:?error}`), in order of first use. `$$` is compose's escape for a
 * literal `$` and is skipped.
 */
export function composeVariables(compose: string): TemplateVariable[] {
  const out = new Map<string, TemplateVariable>()
  for (const m of compose.matchAll(VAR_RE)) {
    const [, name, op, arg] = m
    if (!name) continue
    const v = out.get(name) ?? { name }
    if (op?.endsWith("-") && v.default === undefined) v.default = arg
    if (op?.endsWith("?")) v.required = true
    out.set(name, v)
  }
  return [...out.values()]
}

const SECRET_RE = /PASS(WORD)?|SECRET|TOKEN|(^|_)KEY$/i

/**
 * Variables for a template: the ones declared (with labels and types) first,
 * then any others the compose file or the default .env mentions. Undeclared
 * secret-looking names become password fields.
 */
export function mergeVariables(declared: TemplateVariable[], compose: string, defaultsEnv = ""): TemplateVariable[] {
  const defaults = new Map(parseDotenv(defaultsEnv).entries.map((e) => [e.key, e.value]))
  const out = new Map<string, TemplateVariable>()
  for (const d of declared) out.set(d.name, { ...d })
  for (const v of composeVariables(compose)) {
    const known = out.get(v.name)
    if (known) {
      known.default ??= v.default
      known.required ||= v.required
    } else {
      out.set(v.name, { ...v, type: SECRET_RE.test(v.name) ? "password" : "text" })
    }
  }
  for (const [name, value] of defaults) {
    const known = out.get(name)
    if (known) known.default = value
    else out.set(name, { name, default: value, type: SECRET_RE.test(name) ? "password" : "text" })
  }
  return [...out.values()]
}

export type VariableCheck = { values: Record<string, string>; errors: Record<string, string> }

/**
 * Validates submitted values against the variables. Empty password fields
 * get a generated value (via `generate`); empty fields fall back to their
 * default.
 */
export function checkVariables(
  variables: TemplateVariable[],
  submitted: Record<string, string | undefined>,
  generate: () => string
): VariableCheck {
  const values: Record<string, string> = {}
  const errors: Record<string, string> = {}
  for (const v of variables) {
    let value = (submitted[v.name] ?? "").trim()
    if (!value && v.type === "password") value = generate()
    if (!value && v.default !== undefined) value = v.default
    if (!value) {
      if (v.required) errors[v.name] = "Required"
      values[v.name] = ""
      continue
    }
    if (v.type === "port" && !(/^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535)) {
      errors[v.name] = "Use a port between 1 and 65535"
    } else if (/[\r\n]/.test(value)) {
      errors[v.name] = "Must be a single line"
    } else if (value.length > 4096) {
      errors[v.name] = "Too long"
    } else if (needsDoubleQuotes(value) && value.includes("$")) {
      // Double quotes would interpolate the $.
      errors[v.name] = "Can't contain $ together with ' or a trailing \\"
    }
    values[v.name] = value
  }
  return { values, errors }
}

/** Single quotes are literal, except that compose reads \' as an escaped quote. */
function needsDoubleQuotes(value: string) {
  return value.includes("'") || value.endsWith("\\")
}

/** Quotes a value so docker compose reads it back literally from .env. */
export function dotenvValue(value: string) {
  if (/^[A-Za-z0-9_./:@+,-]*$/.test(value)) return value
  if (!needsDoubleQuotes(value)) return `'${value}'`
  // In double quotes compose unescapes \\ and \" (checkVariables rejects $ here).
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** .env text for a stack created from a template. */
export function renderDotenv(variables: TemplateVariable[], values: Record<string, string>) {
  const lines: string[] = []
  for (const v of variables) {
    if (v.label || v.description) lines.push(`# ${v.label ?? v.name}${v.description ? `: ${v.description}` : ""}`)
    lines.push(`${v.name}=${dotenvValue(values[v.name] ?? "")}`)
  }
  return lines.length ? `${lines.join("\n")}\n` : ""
}

/** Default .env for "save stack as template": secret-looking values are blanked. */
export function templateDefaultsFromEnv(env: string) {
  return parseDotenv(env)
    .entries.map((e) => `${e.key}=${SECRET_RE.test(e.key) ? "" : dotenvValue(e.value)}`)
    .join("\n")
}

const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"

/** Random password from unambiguous letters and digits; `random` fills a byte array. */
export function generatePassword(random: (bytes: Uint8Array) => Uint8Array, length = 24) {
  const out: string[] = []
  // Rejection sampling keeps every character equally likely.
  const limit = 256 - (256 % CHARSET.length)
  while (out.length < length) {
    for (const b of random(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out.push(CHARSET[b % CHARSET.length])
    }
  }
  return out.join("")
}
