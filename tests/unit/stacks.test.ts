import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  composeArgs,
  composeEnv,
  dockerHost,
  operationCommands,
  OutputBuffer,
  removeStackDir,
  runCompose,
  stackDir,
  stacksRoot,
  stripAnsi,
  writeCerts,
  writeStackFiles,
} from "@/lib/server/stacks/compose"
import {
  normalizeText,
  parseDotenv,
  stackNameSchema,
  stackStatus,
  validateCompose,
  validateDotenv,
} from "@/lib/stacks"

describe("stack names", () => {
  it.each(["web", "my-app", "app_2", "0day", "a".repeat(63)])("accepts %s", (name) => {
    expect(stackNameSchema.safeParse(name).success).toBe(true)
  })

  it.each(["", "-app", "_app", "My-App", "app.v2", "app name", "../etc", "a".repeat(64), "app/x"])(
    "rejects %j",
    (name) => {
      expect(stackNameSchema.safeParse(name).success).toBe(false)
    }
  )
})

describe("validateCompose", () => {
  it("accepts a services mapping and lists the services", () => {
    const res = validateCompose("services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n")
    expect(res).toEqual({ ok: true, services: ["web", "db"] })
  })

  it("reports YAML syntax errors with a position", () => {
    const res = validateCompose("services:\n  web:\n    image: [nginx\n")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/^Invalid YAML: .*line \d+/)
  })

  it("rejects duplicate keys", () => {
    const res = validateCompose("services:\n  web:\n    image: a\n  web:\n    image: b\n")
    expect(res.ok).toBe(false)
  })

  it.each([
    ["", /empty/],
    ["just a string", /mapping/],
    ["- a\n- b\n", /mapping/],
    ["version: '3'\n", /services/],
    ["services: []\n", /services/],
    ["services: {}\n", /at least one service/],
    ["services:\n  web: nginx\n", /must be a mapping/],
    ["services:\n  web:\n    image: a\n---\nservices: {}\n", /Invalid YAML/],
  ])("rejects %j", (text, message) => {
    const res = validateCompose(text)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(message)
  })

  it("rejects oversized files", () => {
    const res = validateCompose(`services:\n  web:\n    image: a\n# ${"x".repeat(600 * 1024)}\n`)
    expect(res.ok).toBe(false)
  })
})

describe("dotenv", () => {
  it("parses plain, exported, quoted and commented lines", () => {
    const text = [
      "# comment",
      "",
      "A=1",
      "export B = two words # trailing comment",
      "C='single $literal # not a comment'",
      'D="line1\\nline2"',
      'E="multi',
      'line"',
      "F=",
      "G.H-I=x",
    ].join("\n")
    const { entries, errors } = parseDotenv(text)
    expect(errors).toEqual([])
    expect(entries).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two words" },
      { key: "C", value: "single $literal # not a comment" },
      { key: "D", value: "line1\nline2" },
      { key: "E", value: "multi\nline" },
      { key: "F", value: "" },
      { key: "G.H-I", value: "x" },
    ])
  })

  it("handles CRLF line endings", () => {
    expect(parseDotenv("A=1\r\nB=2\r\n").entries).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "2" },
    ])
  })

  it("reports malformed lines with their line number", () => {
    const { errors } = parseDotenv("A=1\nnot a pair\n1BAD=x\nQ='open\n")
    expect(errors).toEqual([
      "Line 2: expected KEY=value",
      'Line 3: invalid variable name "1BAD"',
      "Line 4: unterminated single quote",
    ])
    expect(validateDotenv("A=1\nnope\n")).toMatch(/Line 2/)
    expect(validateDotenv("")).toBeNull()
  })

  it("normalizes text for files on disk", () => {
    expect(normalizeText("a: 1\r\nb: 2")).toBe("a: 1\nb: 2\n")
    expect(normalizeText("a\n\n\n")).toBe("a\n")
    expect(normalizeText("  \n ")).toBe("")
  })
})

describe("stack status", () => {
  it("summarises running/total", () => {
    expect(stackStatus(0, 0)).toBe("down")
    expect(stackStatus(2, 2)).toBe("running")
    expect(stackStatus(1, 2)).toBe("partial")
    expect(stackStatus(0, 2)).toBe("stopped")
  })
})

describe("compose command line", () => {
  it("always passes project name, file and env file explicitly", () => {
    expect(composeArgs("web", ["up", "-d"])).toEqual([
      "compose",
      "--ansi",
      "never",
      "--progress",
      "plain",
      "-p",
      "web",
      "-f",
      "docker-compose.yml",
      "--env-file",
      ".env",
      "up",
      "-d",
    ])
    expect(() => composeArgs("--host=evil", ["up"])).toThrow()
  })

  it("maps operations to compose subcommands", () => {
    expect(operationCommands("deploy")).toEqual([["up", "-d", "--remove-orphans"]])
    expect(operationCommands("redeploy")).toEqual([["pull"], ["up", "-d", "--remove-orphans"]])
    expect(operationCommands("down")).toEqual([["down", "--remove-orphans"]])
    expect(operationCommands("down", { removeVolumes: true })).toEqual([["down", "--remove-orphans", "-v"]])
    expect(operationCommands("restart")).toEqual([["restart"]])
  })

  it("builds DOCKER_HOST for socket and tcp environments", () => {
    expect(dockerHost({ type: "socket", url: "/var/run/docker.sock" })).toBe("unix:///var/run/docker.sock")
    expect(dockerHost({ type: "tcp", url: "10.0.0.5:2375" })).toBe("tcp://10.0.0.5:2375")
    expect(dockerHost({ type: "tcp", url: "tcp://10.0.0.5:2376" })).toBe("tcp://10.0.0.5:2376")
    expect(dockerHost({ type: "tcp", url: "http://host:2375" })).toBe("tcp://host:2375")
  })

  it("gives the CLI a minimal environment without Gantry's secrets", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/home/node",
      GANTRY_SECRET: "s3cret",
      MYSQL_PASSWORD: "pw",
      DATABASE_URL: "mysql://u:p@h/db",
      DOCKER_HOST: "tcp://wrong:2375",
      DOCKER_TLS_VERIFY: "1",
      DOCKER_CONFIG: "/data/docker",
      TZ: "UTC",
    } as unknown as NodeJS.ProcessEnv
    const env = composeEnv({ type: "socket", url: "/run/docker.sock" }, null, base)
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/node",
      DOCKER_HOST: "unix:///run/docker.sock",
      DOCKER_CONFIG: "/data/docker",
      TZ: "UTC",
    })
  })

  it("adds TLS variables when certificates are written", () => {
    const env = composeEnv({ type: "tcp", url: "h:2376" }, "/tmp/certs", { PATH: "/bin" } as unknown as NodeJS.ProcessEnv)
    expect(env.DOCKER_TLS_VERIFY).toBe("1")
    expect(env.DOCKER_CERT_PATH).toBe("/tmp/certs")
    expect(env.DOCKER_HOST).toBe("tcp://h:2376")
  })
})

describe("stack files", () => {
  it("keeps stack directories inside the data dir", () => {
    expect(stackDir(3, "web")).toBe(path.join(stacksRoot(), "3-web"))
    expect(() => stackDir(3, "../../etc")).toThrow()
    expect(() => stackDir(0, "web")).toThrow()
  })

  it("writes compose and .env files privately and removes them", async () => {
    const dir = stackDir(999, "unit-test")
    await writeStackFiles(dir, "services: {}\n", "A=1\n")
    expect(fs.readFileSync(path.join(dir, "docker-compose.yml"), "utf8")).toBe("services: {}\n")
    expect(fs.statSync(path.join(dir, ".env")).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    await removeStackDir(dir)
    expect(fs.existsSync(dir)).toBe(false)
    await expect(removeStackDir("/tmp")).rejects.toThrow()
  })

  it("writes TLS material into a private temp dir", async () => {
    const dir = await writeCerts({ ca: "CA", cert: "CERT", key: "KEY" })
    try {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
      expect(fs.readdirSync(dir).sort()).toEqual(["ca.pem", "cert.pem", "key.pem"])
      expect(fs.statSync(path.join(dir, "key.pem")).mode & 0o777).toBe(0o600)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("output", () => {
  it("strips ANSI escapes", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m \x1b[2K\x1b[1Adone")).toBe("ok done")
  })

  it("keeps only the tail when the output is too long", () => {
    const buf = new OutputBuffer(10)
    buf.append("0123456789")
    buf.append("abcde")
    expect(buf.toString()).toBe("[… 5 earlier characters truncated …]\n56789abcde")
  })
})

describe("runCompose", () => {
  let tmp = ""
  let cwd = ""
  const prevCli = process.env.DOCKER_CLI

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-unit-"))
    cwd = path.join(tmp, "work")
    fs.mkdirSync(cwd)
  })

  afterAll(() => {
    if (prevCli === undefined) delete process.env.DOCKER_CLI
    else process.env.DOCKER_CLI = prevCli
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  function fakeCli(body: string) {
    const file = path.join(tmp, `docker-${Math.random().toString(36).slice(2)}`)
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    process.env.DOCKER_CLI = file
  }

  it("runs every command with the stack's cwd and environment, cleaning up TLS files", async () => {
    fakeCli(
      [
        'echo "args: $*"',
        'echo "cwd: $(pwd)"',
        'echo "host: $DOCKER_HOST tls: $DOCKER_TLS_VERIFY"',
        'ls "$DOCKER_CERT_PATH" | tr "\\n" " "; echo',
        'echo "cert-path: $DOCKER_CERT_PATH"',
        'echo "secret: [$GANTRY_SECRET]" >&2',
      ].join("\n")
    )
    const run = await runCompose({
      target: { type: "tcp", url: "10.1.2.3:2376", tls: { ca: "a", cert: "b", key: "c" } },
      project: "demo",
      cwd,
      commands: [["pull"], ["up", "-d"]],
      timeoutMs: 10_000,
    })
    expect(run.code).toBe(0)
    expect(run.timedOut).toBe(false)
    expect(run.output).toContain("$ docker compose pull\nargs: compose --ansi never --progress plain -p demo -f docker-compose.yml --env-file .env pull")
    expect(run.output).toContain("args: compose --ansi never --progress plain -p demo -f docker-compose.yml --env-file .env up -d")
    expect(run.output).toContain(`cwd: ${fs.realpathSync(cwd)}`)
    expect(run.output).toContain("host: tcp://10.1.2.3:2376 tls: 1")
    expect(run.output).toContain("ca.pem cert.pem key.pem")
    expect(run.output).toContain("secret: []")
    const certPath = /cert-path: (\S+)/.exec(run.output)?.[1]
    expect(certPath).toBeTruthy()
    expect(fs.existsSync(certPath!)).toBe(false)
  })

  it("stops at the first failing command", async () => {
    fakeCli('echo "running $*"; exit 4')
    const run = await runCompose({
      target: { type: "socket", url: "/var/run/docker.sock" },
      project: "demo",
      cwd,
      commands: [["pull"], ["up", "-d"]],
      timeoutMs: 10_000,
    })
    expect(run.code).toBe(4)
    expect(run.output).toContain("Exited with code 4")
    expect(run.output).not.toContain("up -d")
  })

  it("kills commands that exceed the timeout", async () => {
    fakeCli("exec sleep 30")
    const started = Date.now()
    const run = await runCompose({
      target: { type: "socket", url: "/var/run/docker.sock" },
      project: "demo",
      cwd,
      commands: [["up", "-d"]],
      timeoutMs: 300,
    })
    expect(run.timedOut).toBe(true)
    expect(run.output).toMatch(/Timed out/)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("explains a missing docker CLI", async () => {
    process.env.DOCKER_CLI = path.join(tmp, "does-not-exist")
    const run = await runCompose({
      target: { type: "socket", url: "/var/run/docker.sock" },
      project: "demo",
      cwd,
      commands: [["up", "-d"]],
      timeoutMs: 5_000,
    })
    expect(run.code).not.toBe(0)
    expect(run.output).toMatch(/docker CLI was not found/)
  })
})
