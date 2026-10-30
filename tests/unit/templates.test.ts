import { describe, expect, it } from "vitest"

import { BUILTIN_TEMPLATES } from "@/lib/template-catalog"
import {
  checkVariables,
  composeVariables,
  customTemplateId,
  dotenvValue,
  generatePassword,
  mergeVariables,
  renderDotenv,
  templateDefaultsFromEnv,
} from "@/lib/templates"
import { parseDotenv, STACK_NAME_RE, validateCompose } from "@/lib/stacks"

describe("composeVariables", () => {
  it("finds ${VAR}, defaults and required markers, skipping $$ escapes", () => {
    const vars = composeVariables(
      'image: "app:${TAG:-latest}"\nports: ["${PORT}:80"]\ncommand: echo $${HOME} ${NAME:?set it} ${PORT} ${EMPTY-}\n'
    )
    expect(vars).toEqual([
      { name: "TAG", default: "latest" },
      { name: "PORT" },
      { name: "NAME", required: true },
      { name: "EMPTY", default: "" },
    ])
  })
})

describe("mergeVariables", () => {
  it("keeps declared metadata, adds undeclared ones and .env defaults; secrets become passwords", () => {
    const vars = mergeVariables(
      [{ name: "PORT", label: "Port", type: "port" }],
      "x: ${PORT:-80} ${DB_PASSWORD} ${API_KEY} ${MODE}",
      "MODE=prod\nEXTRA=1\n"
    )
    expect(vars).toEqual([
      { name: "PORT", label: "Port", type: "port", default: "80" },
      { name: "DB_PASSWORD", type: "password" },
      { name: "API_KEY", type: "password" },
      { name: "MODE", type: "text", default: "prod" },
      { name: "EXTRA", default: "1", type: "text" },
    ])
  })
})

describe("checkVariables", () => {
  const gen = () => "GENERATED"
  it("fills defaults, generates passwords and validates", () => {
    const res = checkVariables(
      [
        { name: "PORT", type: "port", default: "8080", required: true },
        { name: "PW", type: "password", required: true },
        { name: "NEEDED", required: true },
        { name: "BAD_PORT", type: "port" },
        { name: "MIXED" },
      ],
      { PORT: "", PW: "", NEEDED: "", BAD_PORT: "70000", MIXED: `it's "$x"` },
      gen
    )
    expect(res.values.PORT).toBe("8080")
    expect(res.values.PW).toBe("GENERATED")
    expect(res.errors).toEqual({
      NEEDED: "Required",
      BAD_PORT: "Use a port between 1 and 65535",
      MIXED: expect.stringContaining("Can't contain $"),
    })
  })
})

describe(".env rendering", () => {
  it.each(["plain", "with space", "it's", "a$b\\c\"d", "#hash", "", "x=y", "ends\\", "it's \\ \"q\""])("round-trips %j", (value) => {
    const text = `K=${dotenvValue(value)}\n`
    expect(parseDotenv(text).entries).toEqual([{ key: "K", value }])
  })

  it("comments labelled variables", () => {
    expect(renderDotenv([{ name: "A", label: "Port", description: "host port" }, { name: "B" }], { A: "1", B: "x y" })).toBe(
      "# Port: host port\nA=1\nB='x y'\n"
    )
  })

  it("blanks secret-looking values when saving a stack as a template", () => {
    expect(templateDefaultsFromEnv("PORT=80\nDB_PASSWORD=hunter2\nAPI_TOKEN=t\nNAME='a b'\n")).toBe(
      "PORT=80\nDB_PASSWORD=\nAPI_TOKEN=\nNAME='a b'"
    )
  })
})

describe("generatePassword", () => {
  it("uses only unambiguous letters and digits", () => {
    let seed = 0
    const pw = generatePassword((b) => b.map(() => seed++ % 256))
    expect(pw).toHaveLength(24)
    expect(pw).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/)
    expect(generatePassword((b) => crypto.getRandomValues(b), 40)).toHaveLength(40)
  })
})

describe("template keys", () => {
  it("parses custom keys only", () => {
    expect(customTemplateId("c-12")).toBe(12)
    expect(customTemplateId("nginx")).toBeNull()
    expect(customTemplateId("c-0")).toBeNull()
    expect(customTemplateId("c-1x")).toBeNull()
  })
})

describe("built-in catalog", () => {
  it("has unique keys and valid compose files whose variables are all declared", () => {
    const keys = new Set<string>()
    for (const t of BUILTIN_TEMPLATES) {
      expect(keys.has(t.key), t.key).toBe(false)
      keys.add(t.key)
      expect(t.key.startsWith("c-"), t.key).toBe(false)
      expect(STACK_NAME_RE.test(t.stackName), t.key).toBe(true)
      expect(validateCompose(t.compose), t.key).toMatchObject({ ok: true })
      const declared = new Set(t.variables.map((v) => v.name))
      for (const v of composeVariables(t.compose)) expect(declared.has(v.name), `${t.key}: ${v.name}`).toBe(true)
    }
  })
})

describe("composeServicePorts", () => {
  it("lists container ports per service from short and long syntax", async () => {
    const { composeServicePorts, composeContainerName } = await import("@/lib/compose-ports")
    const compose = `services:
  web:
    image: nginx
    ports:
      - "\${HTTP_PORT}:80"
      - 127.0.0.1:8443:443/tcp
      - "9000-9010:9000-9010"
  db:
    image: postgres
    ports:
      - target: 5432
        published: "5432"
  worker:
    image: x
`
    expect(composeServicePorts(compose)).toEqual([
      { service: "web", port: 80 },
      { service: "web", port: 443 },
      { service: "db", port: 5432 },
    ])
    expect(composeContainerName("shop", "web")).toBe("shop-web-1")
  })
})
