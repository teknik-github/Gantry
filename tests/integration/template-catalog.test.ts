import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { BUILTIN_TEMPLATES } from "@/lib/template-catalog"
import { checkVariables, generatePassword, renderDotenv } from "@/lib/templates"

// Every built-in template, rendered with its defaults and generated
// passwords, must pass `docker compose config` (syntax and interpolation).
const hasCompose = spawnSync("docker", ["compose", "version"]).status === 0

describe.skipIf(!hasCompose)("built-in templates with docker compose", () => {
  it.each(BUILTIN_TEMPLATES.map((t) => [t.key, t] as const))("%s renders", (_key, template) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-template-"))
    try {
      const check = checkVariables(template.variables, {}, () => generatePassword((b) => crypto.getRandomValues(b)))
      expect(check.errors).toEqual({})
      fs.writeFileSync(path.join(dir, "docker-compose.yml"), template.compose)
      fs.writeFileSync(path.join(dir, ".env"), renderDotenv(template.variables, check.values))
      const res = spawnSync(
        "docker",
        ["compose", "-p", template.stackName, "-f", "docker-compose.yml", "--env-file", ".env", "config", "--format", "json"],
        { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } as unknown as NodeJS.ProcessEnv }
      )
      expect(res.stderr).not.toMatch(/variable is not set/i)
      expect(res.status, res.stderr).toBe(0)
      const config = JSON.parse(res.stdout) as { services: Record<string, { image: string }> }
      for (const svc of Object.values(config.services)) expect(svc.image).toBeTruthy()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!hasCompose)(".env values as docker compose reads them", () => {
  it("round-trips quotes, backslashes and spaces", () => {
    const values = ["ends\\", "it's \\ \"q\"", "a\\b", "x y", "p@ss:w0rd", "#not a comment", "it's"]
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-dotenv-"))
    try {
      const variables = values.map((_, i) => ({ name: `V${i}` }))
      fs.writeFileSync(path.join(dir, ".env"), renderDotenv(variables, Object.fromEntries(values.map((v, i) => [`V${i}`, v]))))
      fs.writeFileSync(
        path.join(dir, "docker-compose.yml"),
        `services:\n  a:\n    image: alpine\n    environment:\n${values.map((_, i) => `      V${i}: \${V${i}}\n`).join("")}`
      )
      const res = spawnSync("docker", ["compose", "--env-file", ".env", "config", "--format", "json"], {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir } as unknown as NodeJS.ProcessEnv,
      })
      expect(res.status, res.stderr).toBe(0)
      const env = (JSON.parse(res.stdout) as { services: { a: { environment: Record<string, string> } } }).services.a.environment
      expect(values.map((_, i) => env[`V${i}`])).toEqual(values)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
