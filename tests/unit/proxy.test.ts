import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"

import { buildCaddyfile, checkHost, checkSettings, externalSnippets, normalizeDomain, parseDomains } from "@/lib/proxy"
import { singleFileTar } from "@/lib/server/tar"

describe("domains", () => {
  it.each([
    ["App.Example.com", "app.example.com"],
    ["example.com.", "example.com"],
    ["*.example.com", "*.example.com"],
    ["localhost", "localhost"],
    ["my-app.lan", "my-app.lan"],
  ])("%s → %s", (input, out) => expect(normalizeDomain(input)).toBe(out))

  it.each(["", "example", "-bad.com", "bad-.com", "a..b", "*.com", "foo.*.com", "ex ample.com", "x/y.com", "{ respond }"])(
    "rejects %j",
    (input) => expect(normalizeDomain(input)).toBeNull()
  )

  it("splits on commas and whitespace, dedupes and reports invalid ones", () => {
    expect(parseDomains("a.com, b.com\nA.com bad")).toEqual({ domains: ["a.com", "b.com"], invalid: ["bad"] })
  })
})

describe("checkHost", () => {
  const base = { domains: "app.example.com", target: "web-1", port: "3000", tls: "auto" }
  it("accepts a valid host", () => {
    expect(checkHost(base, [])).toEqual({ host: { domains: ["app.example.com"], target: "web-1", port: 3000, tls: "auto" }, errors: {} })
  })
  it("refuses duplicates (except itself), bad ports and Let's Encrypt for private names", () => {
    expect(checkHost(base, [{ id: 1, domains: ["app.example.com"] }]).errors.domains).toMatch(/Already used/)
    expect(checkHost(base, [{ id: 1, domains: ["app.example.com"] }], 1).errors).toEqual({})
    expect(checkHost({ ...base, port: "70000" }, []).errors.port).toBe("1-65535")
    expect(checkHost({ ...base, domains: "nas.lan" }, []).errors.tls).toMatch(/public domains/)
    expect(checkHost({ ...base, domains: "nas.lan", tls: "internal" }, []).errors).toEqual({})
    expect(checkHost({ ...base, target: "bad name" }, []).errors.target).toBe("Pick a container")
  })
})

describe("checkSettings", () => {
  it("validates ports, email and the external network", () => {
    expect(checkSettings({ mode: "internal", httpPort: "8080", httpsPort: "8443", email: "", externalNetwork: "" })).toEqual({
      settings: { mode: "internal", httpPort: 8080, httpsPort: 8443, email: "", externalNetwork: "" },
      errors: {},
    })
    expect(checkSettings({ mode: "internal", httpPort: "80", httpsPort: "80" }).errors).toEqual({ httpsPort: "Must differ from the HTTP port" })
    expect(checkSettings({ mode: "internal", email: "x@y" }).errors.email).toBe("Not a valid email")
    expect(checkSettings({ mode: "external", externalNetwork: "" }).errors.externalNetwork).toBeTruthy()
    expect(checkSettings({ mode: "sideways" }).errors.mode).toBe("Pick a mode")
  })
})

describe("buildCaddyfile", () => {
  it("renders enabled hosts per TLS mode", () => {
    const text = buildCaddyfile(
      [
        { domains: ["a.example.com", "www.a.example.com"], target: "web", port: 80, tls: "auto", enabled: true },
        { domains: ["nas.lan"], target: "nas", port: 5000, tls: "internal", enabled: true },
        { domains: ["plain.lan"], target: "p", port: 8080, tls: "off", enabled: true },
        { domains: ["off.example.com"], target: "x", port: 1, tls: "auto", enabled: false },
      ],
      { email: "ops@example.com" }
    )
    expect(text).toContain("\temail ops@example.com")
    expect(text).toContain("a.example.com, www.a.example.com {\n\treverse_proxy web:80\n}")
    expect(text).toContain("nas.lan {\n\ttls internal\n\treverse_proxy nas:5000\n}")
    expect(text).toContain("http://plain.lan {\n\treverse_proxy p:8080\n}")
    expect(text).not.toContain("off.example.com")
  })

  it("serves a placeholder without hosts", () => {
    expect(buildCaddyfile([], { email: "" })).toContain(':80 {\n\trespond "Gantry proxy: no hosts configured" 404\n}')
  })
})

describe("externalSnippets", () => {
  it("builds Traefik labels, a Caddyfile block and an nginx server", () => {
    const s = externalSnippets({ id: 7, domains: ["a.example.com", "*.b.example.com"], target: "web", port: 3000, tls: "auto", enabled: true }, "proxy")
    expect(s.traefik).toContain("traefik.docker.network=proxy")
    expect(s.traefik).toContain("traefik.http.routers.gantry-7.rule=Host(`a.example.com`) || HostRegexp(`^.+\\.b\\.example\\.com$`)")
    expect(s.traefik).toContain("traefik.http.routers.gantry-7.tls.certresolver=letsencrypt")
    expect(s.traefik).toContain("traefik.http.services.gantry-7.loadbalancer.server.port=3000")
    expect(s.caddy).toBe("a.example.com, *.b.example.com {\n\treverse_proxy web:3000\n}")
    expect(s.nginx).toContain("server_name a.example.com *.b.example.com;")
    expect(s.nginx).toContain("proxy_pass http://web:3000;")
  })
})

describe("singleFileTar", () => {
  it("is a valid tar the system tar can read", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-tar-"))
    try {
      const content = "line one\n".repeat(100)
      fs.writeFileSync(path.join(dir, "a.tar"), singleFileTar("Caddyfile", content))
      expect(execFileSync("tar", ["-tf", "a.tar"], { cwd: dir, encoding: "utf8" }).trim()).toBe("Caddyfile")
      execFileSync("tar", ["-xf", "a.tar"], { cwd: dir })
      expect(fs.readFileSync(path.join(dir, "Caddyfile"), "utf8")).toBe(content)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses path-like names", () => {
    expect(() => singleFileTar("../x", "")).toThrow()
  })
})
