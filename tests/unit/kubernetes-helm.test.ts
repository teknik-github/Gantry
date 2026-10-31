import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import {
  chartVersionSchema,
  checkRepoCredentials,
  checkValuesYaml,
  releaseNameSchema,
  repoNameSchema,
  validateOciRef,
  validateRepoUrl,
} from "@/lib/kubernetes/helm-charts"
import { parseKubeconfig } from "@/lib/server/kubernetes/connection"
import { lockRelease, runHelm, withHelmWorkspace } from "@/lib/server/kubernetes/helm-cli"
import { credentialSecrets, ociHost, registryConfigJson, repositoriesYaml } from "@/lib/server/kubernetes/helm-repos"
import { buildKubeconfig, lineRedactor, redactSecrets, secretsOf } from "@/lib/server/kubernetes/kubeconfig"

import { generateTlsFixtures, type TlsFixtures } from "../helpers/tls-docker-proxy"

let fx: TlsFixtures
beforeAll(() => {
  fx = generateTlsFixtures()
})
afterAll(() => fx?.cleanup())

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.gantry-unit-token.signature-part"

// -------------------------------------------------------------- kubeconfig

describe("buildKubeconfig", () => {
  it("round-trips a token and CA through the kubeconfig parser", () => {
    const text = buildKubeconfig({ server: "https://10.0.0.5:6443", token: TOKEN, ca: fx.ca }, "apps")
    const res = parseKubeconfig(text)
    expect(res.errors).toBeUndefined()
    expect(res.connection).toEqual({
      server: "https://10.0.0.5:6443",
      credentials: { token: TOKEN, ca: fx.ca },
      insecure: false,
      namespace: "apps",
    })
  })

  it("embeds a client certificate and key, and the insecure flag", () => {
    const text = buildKubeconfig({ server: "https://k8s.example.com/proxy/c-1", cert: fx.client.cert, key: fx.client.key, insecure: true })
    const res = parseKubeconfig(text)
    expect(res.errors).toBeUndefined()
    expect(res.connection?.server).toBe("https://k8s.example.com/proxy/c-1")
    expect(res.connection?.credentials.cert?.trim()).toBe(fx.client.cert.trim())
    expect(res.connection?.credentials.key?.trim()).toBe(fx.client.key.trim())
    expect(res.connection?.insecure).toBe(true)
    // Embedded as base64 data, never as file references.
    expect(text).toContain("client-key-data:")
    expect(text).not.toContain("client-key:")
    expect(text).not.toContain("BEGIN")
  })

  it("leaves out what isn't stored", () => {
    const text = buildKubeconfig({ server: "https://h:6443", token: TOKEN })
    expect(text).not.toContain("certificate-authority-data")
    expect(text).not.toContain("insecure-skip-tls-verify")
    expect(text).not.toContain("client-certificate-data")
  })
})

// --------------------------------------------------------------- redaction

describe("redaction", () => {
  it("removes the token, the key in PEM and base64 form, and repository passwords", () => {
    const secrets = secretsOf({ token: TOKEN, key: fx.client.key, cert: fx.client.cert }, credentialSecrets({ username: "bob", password: "repo-pass-123" }))
    const keyLine = fx.client.key.split("\n")[1]
    const text = [
      `token=${TOKEN}`,
      `key ${Buffer.from(fx.client.key).toString("base64")}`,
      `partial ${keyLine}`,
      "Error: 401 for repo-pass-123",
      `basic ${Buffer.from("bob:repo-pass-123").toString("base64")}`,
    ].join("\n")
    const out = redactSecrets(text, secrets)
    expect(out).not.toContain(TOKEN)
    expect(out).not.toContain(keyLine)
    expect(out).not.toContain("repo-pass-123")
    expect(out).not.toContain(Buffer.from("bob:repo-pass-123").toString("base64"))
    expect(out).toContain("[redacted]")
  })

  it("catches credential-looking text even when it wasn't listed", () => {
    const out = redactSecrets(`${fx.client.key}\nAuthorization: Bearer abcdefghijklmnop\npassword: hunter2hunter2\n`, [])
    expect(out).not.toContain("PRIVATE KEY-----\nMII")
    expect(out).toContain("[redacted private key]")
    expect(out).not.toContain("abcdefghijklmnop")
    expect(out).not.toContain("hunter2hunter2")
  })

  it("exactOnly leaves values that merely look like credentials (parsed output)", () => {
    expect(redactSecrets("password: changeme123\nauth:\n  enabled: true\n", ["zzzzzz"], true)).toBe("password: changeme123\nauth:\n  enabled: true\n")
    // A YAML key followed by a nested mapping is never mistaken for a value.
    expect(redactSecrets("auth:\n  enabled: true\n", [])).toBe("auth:\n  enabled: true\n")
  })

  it("redacts a secret split across stream chunks", () => {
    const out: string[] = []
    const r = lineRedactor([TOKEN], (t) => out.push(t))
    const line = `using ${TOKEN} now\nnext line\n`
    r.push(line.slice(0, 12))
    r.push(line.slice(12, 30))
    r.push(line.slice(30))
    r.push("tail without newline")
    r.flush()
    const text = out.join("")
    expect(text).not.toContain(TOKEN)
    expect(text).toBe("using [redacted] now\nnext line\ntail without newline")
  })
})

// ---------------------------------------------------------------- validation

describe("chart repository validation", () => {
  it("accepts https, http and oci addresses and normalises them", () => {
    expect(validateRepoUrl("https://charts.example.com/stable/")).toEqual({ ok: true, value: { url: "https://charts.example.com/stable", oci: false } })
    expect(validateRepoUrl("http://charts.lan:8080")).toEqual({ ok: true, value: { url: "http://charts.lan:8080", oci: false } })
    expect(validateRepoUrl("oci://registry.example.com:5000/charts/")).toEqual({
      ok: true,
      value: { url: "oci://registry.example.com:5000/charts", oci: true },
    })
  })

  it("refuses other schemes, embedded credentials, queries and option-like input", () => {
    for (const bad of ["ftp://x/y", "file:///etc", "https://u:p@charts.example.com", "https://x/y?a=1", "https://x/#f", "-https://x", "not a url", ""]) {
      expect(validateRepoUrl(bad).ok, bad).toBe(false)
    }
  })

  it("refuses credentials over plain http except to loopback", () => {
    expect(validateRepoUrl("http://charts.lan", { withCredentials: true }).ok).toBe(false)
    expect(validateRepoUrl("http://127.0.0.1:8080", { withCredentials: true }).ok).toBe(true)
    expect(validateRepoUrl("https://charts.lan", { withCredentials: true }).ok).toBe(true)
  })

  it("checks OCI chart references", () => {
    expect(validateOciRef("oci://ghcr.io/org/charts/app")).toEqual({ ok: true, value: "oci://ghcr.io/org/charts/app" })
    expect(validateOciRef("https://ghcr.io/org/app").ok).toBe(false)
    expect(validateOciRef("oci://ghcr.io").ok).toBe(false)
    expect(validateOciRef("oci://ghcr.io/org/app?x=1").ok).toBe(false)
  })

  it("checks names, versions and credentials", () => {
    expect(repoNameSchema.safeParse("bitnami").success).toBe(true)
    expect(repoNameSchema.safeParse("Bit Nami").success).toBe(false)
    expect(repoNameSchema.safeParse("-x").success).toBe(false)
    expect(releaseNameSchema.safeParse("my-app.v2").success).toBe(true)
    expect(releaseNameSchema.safeParse("a".repeat(54)).success).toBe(false)
    expect(releaseNameSchema.safeParse("--set=x").success).toBe(false)
    expect(chartVersionSchema.safeParse("").success).toBe(true)
    expect(chartVersionSchema.safeParse("1.2.3-rc.1+build.5").success).toBe(true)
    expect(chartVersionSchema.safeParse(">=1.0.0, <2.0.0").success).toBe(true)
    expect(chartVersionSchema.safeParse("--devel").success).toBe(false)
    expect(chartVersionSchema.safeParse("1.0;rm").success).toBe(false)
    expect(checkRepoCredentials("", "")).toBeNull()
    expect(checkRepoCredentials("bob", "")).not.toBeNull()
    expect(checkRepoCredentials("", "pw")).not.toBeNull()
    expect(checkRepoCredentials("bo b", "pw")).not.toBeNull()
    expect(checkRepoCredentials("bob", "pw\nx")).not.toBeNull()
    expect(checkRepoCredentials("bob", "pw")).toBeNull()
  })

  it("accepts empty or mapping values only", () => {
    expect(checkValuesYaml("")).toEqual({ ok: true, value: "" })
    expect(checkValuesYaml("# only a comment\n")).toEqual({ ok: true, value: "" })
    expect(checkValuesYaml("a: 1\nb:\n  c: [1, 2]\n").ok).toBe(true)
    expect(checkValuesYaml("- 1\n- 2\n").ok).toBe(false)
    expect(checkValuesYaml("a: 1\na: 2\n").ok).toBe(false)
    expect(checkValuesYaml("a: [\n").ok).toBe(false)
  })
})

describe("helm config files", () => {
  it("lists one repository with its login in repositories.yaml", () => {
    const yaml = repositoriesYaml({ name: "internal", url: "https://charts.example.com", credentials: { username: "bob", password: "pw: tricky\"" } })
    expect(yaml).toContain("name: internal")
    expect(yaml).toContain("url: https://charts.example.com")
    expect(yaml).toContain("username: bob")
    // Quoted by the YAML writer, not interpolated.
    expect(yaml).toMatch(/password: ['"]pw: tricky/)
  })

  it("writes registry logins as docker config auths", () => {
    expect(ociHost("oci://registry.example.com:5000/charts/app")).toBe("registry.example.com:5000")
    const cfg = JSON.parse(registryConfigJson("registry.example.com:5000", { username: "bob", password: "pw" }))
    expect(Buffer.from(cfg.auths["registry.example.com:5000"].auth, "base64").toString()).toBe("bob:pw")
    expect(JSON.parse(registryConfigJson("", null))).toEqual({ auths: {} })
  })
})

// ----------------------------------------------------------------- helm cli

describe("helm workspace and runner", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-unit-helm-bin-"))
  const fakeHelm = path.join(binDir, "helm")
  // A stand-in for helm: prints its kubeconfig (credentials!), argv and environment, or sleeps.
  fs.writeFileSync(
    fakeHelm,
    `#!/bin/sh
case "$1" in
  leak) cat "$KUBECONFIG"; echo "ARGS $*"; env | sort; exit 0 ;;
  sleep) sleep 30 ;;
  fail) echo "Error: INSTALLATION FAILED: boom with ${TOKEN}" >&2; exit 1 ;;
esac
`,
    { mode: 0o755 }
  )
  const previous = process.env.HELM_BIN
  beforeAll(() => {
    process.env.HELM_BIN = fakeHelm
    process.env.GANTRY_UNIT_PRIVATE = "do-not-pass-me"
  })
  afterEach(() => {})
  afterAll(() => {
    if (previous === undefined) delete process.env.HELM_BIN
    else process.env.HELM_BIN = previous
    delete process.env.GANTRY_UNIT_PRIVATE
    fs.rmSync(binDir, { recursive: true, force: true })
  })

  it("gives helm a private kubeconfig and a clean environment, and removes the workspace", async () => {
    let seenDir = ""
    let output = ""
    await withHelmWorkspace({ target: { server: "https://10.0.0.5:6443", token: TOKEN, ca: fx.ca } }, async (ws) => {
      seenDir = ws.dir
      expect(fs.statSync(ws.dir).mode & 0o777).toBe(0o700)
      expect(fs.statSync(path.join(ws.dir, "kubeconfig")).mode & 0o777).toBe(0o600)
      expect(fs.readFileSync(path.join(ws.dir, "kubeconfig"), "utf8")).toContain(TOKEN)
      const res = await runHelm(ws, ["leak", ...ws.kubeArgs], { timeoutMs: 10_000, onOutput: (t) => (output += t) })
      expect(res.code).toBe(0)
    })
    expect(fs.existsSync(seenDir)).toBe(false)
    // The token was printed by "helm" but never reaches the output.
    expect(output).toContain("server: https://10.0.0.5:6443")
    expect(output).not.toContain(TOKEN)
    expect(output).toContain("[redacted]")
    // Nothing of Gantry's own environment; helm dirs under DATA_DIR; paths shown as <tmp>.
    expect(output).not.toContain("GANTRY_SECRET")
    expect(output).not.toContain("do-not-pass-me")
    expect(output).toMatch(/HELM_CONFIG_HOME=.*helm\/config/)
    expect(output).toContain("KUBECONFIG=<tmp>/kubeconfig")
    expect(output).toContain("--kubeconfig=<tmp>/kubeconfig")
  })

  it("removes the workspace when the command throws", async () => {
    let seenDir = ""
    await expect(
      withHelmWorkspace({}, async (ws) => {
        seenDir = ws.dir
        throw new Error("boom")
      })
    ).rejects.toThrow("boom")
    expect(seenDir).not.toBe("")
    expect(fs.existsSync(seenDir)).toBe(false)
  })

  it("stops a command that runs past its timeout", async () => {
    const started = Date.now()
    const res = await withHelmWorkspace({}, (ws) => runHelm(ws, ["sleep"], { timeoutMs: 300 }))
    expect(res.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it("redacts error output", async () => {
    const res = await withHelmWorkspace({ target: { server: "https://h:6443", token: TOKEN } }, (ws) => runHelm(ws, ["fail"], { timeoutMs: 10_000 }))
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("INSTALLATION FAILED")
    expect(res.stderr).not.toContain(TOKEN)
  })

  it("allows one operation per release at a time", () => {
    const release = lockRelease(1, "apps", "web")
    expect(() => lockRelease(1, "apps", "web")).toThrow(/still running/)
    // Other releases and other environments are independent.
    const other = lockRelease(2, "apps", "web")
    other()
    release()
    lockRelease(1, "apps", "web")()
  })
})
