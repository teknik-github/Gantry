import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"

import { dockerConfigJson, normalizeRegistryAddress, registryAuthHeader, registryOf } from "@/lib/registry"
import { composeEnv, runCompose, writeDockerConfig } from "@/lib/server/stacks/compose"

describe("registry addresses", () => {
  it.each([
    ["ghcr.io", "ghcr.io"],
    ["https://GHCR.io/", "ghcr.io"],
    ["registry.example.com:5000", "registry.example.com:5000"],
    ["https://index.docker.io/v1/", "docker.io"],
    ["registry-1.docker.io", "docker.io"],
    ["localhost:5000", "localhost:5000"],
  ])("%s → %s", (input, out) => expect(normalizeRegistryAddress(input)).toBe(out))

  it.each(["", "not a host", "ghcr.io:99999", "-bad.io", "a..b"])("rejects %j", (input) =>
    expect(normalizeRegistryAddress(input)).toBeNull()
  )

  it.each([
    ["nginx", "docker.io"],
    ["nginx:1.27", "docker.io"],
    ["library/nginx", "docker.io"],
    ["myorg/app:2", "docker.io"],
    ["docker.io/myorg/app", "docker.io"],
    ["ghcr.io/org/app:1", "ghcr.io"],
    ["registry.example.com:5000/team/app@sha256:abc", "registry.example.com:5000"],
    ["localhost/app", "localhost"],
    ["localhost:5000/app", "localhost:5000"],
  ])("image %s lives on %s", (ref, host) => expect(registryOf(ref)).toBe(host))
})

describe("registry auth formats", () => {
  it("encodes X-Registry-Auth as base64url JSON (Docker Hub gets its legacy address)", () => {
    const decode = (h: string) => JSON.parse(Buffer.from(h, "base64url").toString("utf8"))
    expect(decode(registryAuthHeader({ address: "ghcr.io", username: "me", password: "p/w+?" }))).toEqual({
      username: "me",
      password: "p/w+?",
      serveraddress: "ghcr.io",
    })
    expect(decode(registryAuthHeader({ address: "docker.io", username: "me", password: "x" })).serveraddress).toBe(
      "https://index.docker.io/v1/"
    )
  })

  it("keeps base64 padding (Docker drops credentials it can't decode)", () => {
    for (const password of ["a", "ab", "abc", "abcd"]) {
      const header = registryAuthHeader({ address: "localhost:5000", username: "u", password })
      expect(header.length % 4, password).toBe(0)
      expect(header).toMatch(/^[A-Za-z0-9_-]+=*$/)
    }
  })

  it("writes config.json auths for the docker CLI", () => {
    const json = JSON.parse(
      dockerConfigJson([
        { address: "ghcr.io", username: "me", password: "tok" },
        { address: "docker.io", username: "hub", password: "pw" },
      ])
    )
    expect(json).toEqual({
      auths: {
        "ghcr.io": { auth: Buffer.from("me:tok").toString("base64") },
        "https://index.docker.io/v1/": { auth: Buffer.from("hub:pw").toString("base64") },
      },
    })
  })
})

describe("registry logins for docker compose", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-registry-"))
  const prevCli = process.env.DOCKER_CLI
  afterAll(() => {
    if (prevCli === undefined) delete process.env.DOCKER_CLI
    else process.env.DOCKER_CLI = prevCli
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("merges Gantry's logins over a mounted DOCKER_CONFIG, in a private dir", async () => {
    const mounted = path.join(tmp, "mounted")
    fs.mkdirSync(path.join(mounted, "cli-plugins"), { recursive: true })
    fs.writeFileSync(
      path.join(mounted, "config.json"),
      JSON.stringify({ auths: { "ghcr.io": { auth: "old" }, "quay.io": { auth: "keep" } }, credsStore: "desktop" })
    )
    const dir = await writeDockerConfig([{ address: "ghcr.io", username: "me", password: "new" }], {
      DOCKER_CONFIG: mounted,
    } as unknown as NodeJS.ProcessEnv)
    try {
      expect(fs.statSync(path.join(dir, "config.json")).mode & 0o777).toBe(0o600)
      const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"))
      expect(config).toEqual({
        auths: { "ghcr.io": { auth: Buffer.from("me:new").toString("base64") }, "quay.io": { auth: "keep" } },
      })
      expect(fs.realpathSync(path.join(dir, "cli-plugins"))).toBe(fs.realpathSync(path.join(mounted, "cli-plugins")))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("points DOCKER_CONFIG at that dir for the run and removes it afterwards", async () => {
    expect(composeEnv({ type: "socket", url: "/s" }, null, { DOCKER_CONFIG: "/x" } as unknown as NodeJS.ProcessEnv, "/tmp/c").DOCKER_CONFIG).toBe("/tmp/c")

    const cli = path.join(tmp, "docker")
    fs.writeFileSync(cli, '#!/bin/sh\necho "config: $DOCKER_CONFIG"\ncat "$DOCKER_CONFIG/config.json"\n', { mode: 0o755 })
    process.env.DOCKER_CLI = cli
    const run = await runCompose({
      target: { type: "socket", url: "/var/run/docker.sock" },
      project: "demo",
      cwd: tmp,
      commands: [["pull"]],
      timeoutMs: 10_000,
      registries: [{ address: "ghcr.io", username: "me", password: "tok" }],
    })
    expect(run.code).toBe(0)
    expect(run.output).toContain(Buffer.from("me:tok").toString("base64"))
    const dir = /config: (\S+)/.exec(run.output)?.[1]
    expect(dir).toBeTruthy()
    expect(fs.existsSync(dir!)).toBe(false)
  })
})
