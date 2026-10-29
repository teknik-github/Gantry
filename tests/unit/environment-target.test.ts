import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { connectionOptions } from "@/lib/server/docker/client"
import { DockerError } from "@/lib/server/docker/client"
import { encryptSecret } from "@/lib/server/crypto"
import { decryptTls, encryptTls, environmentTarget, hasTls, parseTls } from "@/lib/server/environment-target"

import { generateTlsFixtures, type TlsFixtures } from "../helpers/tls-docker-proxy"

let fx: TlsFixtures
beforeAll(() => {
  fx = generateTlsFixtures()
})
afterAll(() => fx?.cleanup())

describe("environmentTarget", () => {
  it("builds a plain target without TLS", () => {
    expect(environmentTarget({ type: "socket", url: "/var/run/docker.sock", tls_ca: null, tls_cert: null, tls_key: null })).toEqual({
      type: "socket",
      url: "/var/run/docker.sock",
      tls: null,
    })
  })

  it("encrypts all three PEM columns and decrypts them back", () => {
    const tls = { ca: fx.ca, ...fx.client }
    const cols = encryptTls(tls)
    for (const v of Object.values(cols)) expect(v).toMatch(/^v1\./)
    expect(JSON.stringify(cols)).not.toContain("BEGIN")
    const row = { type: "tcp" as const, url: "10.0.0.5:2376", ...cols }
    expect(hasTls(row)).toBe(true)
    expect(environmentTarget(row)).toEqual({ type: "tcp", url: "10.0.0.5:2376", tls })
  })

  it("ignores TLS columns on socket environments", () => {
    const row = { type: "socket" as const, url: "/run/docker.sock", ...encryptTls({ ca: fx.ca, ...fx.client }) }
    expect(environmentTarget(row).tls).toBeNull()
  })

  it("reports undecryptable certificates as a Docker error", () => {
    const row = { type: "tcp" as const, tls_ca: "v1.AAAA", tls_cert: "v1.AAAA", tls_key: "v1.AAAA" }
    expect(() => decryptTls(row)).toThrow(DockerError)
    // Swapped columns fail too (context binding).
    const cols = encryptTls({ ca: fx.ca, ...fx.client })
    expect(() => decryptTls({ type: "tcp", tls_ca: cols.tls_key, tls_cert: cols.tls_cert, tls_key: cols.tls_ca })).toThrow(DockerError)
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"))
  })
})

describe("connectionOptions", () => {
  it("uses 2375 without TLS and 2376 with TLS by default", () => {
    expect(connectionOptions({ type: "tcp", url: "tcp://docker.internal" })).toEqual({ host: "docker.internal", port: 2375 })
    const opts = connectionOptions({ type: "tcp", url: "https://docker.internal", tls: { ca: "a", cert: "b", key: "c" } })
    expect(opts).toMatchObject({ host: "docker.internal", port: 2376, ca: "a", cert: "b", key: "c", rejectUnauthorized: true, servername: "docker.internal" })
  })

  it("does not send an IP address as SNI", () => {
    const opts = connectionOptions({ type: "tcp", url: "10.0.0.5:2376", tls: { ca: "a", cert: "b", key: "c" } })
    expect(opts.servername).toBeUndefined()
  })
})

describe("parseTls", () => {
  it("accepts a matching CA, certificate and key (normalising line endings)", () => {
    const res = parseTls({ ca: fx.ca.replace(/\n/g, "\r\n"), cert: `  ${fx.client.cert}`, key: fx.client.key })
    expect(res.errors).toBeUndefined()
    expect(res.tls?.ca).toBe(fx.ca)
    expect(res.tls?.cert).toBe(fx.client.cert)
  })

  it("accepts a CA bundle", () => {
    expect(parseTls({ ca: fx.ca + fx.rogueCa, ...fx.client }).errors).toBeUndefined()
  })

  it("requires all three fields", () => {
    expect(parseTls({ ca: "", cert: "", key: "" }).errors).toEqual({
      tls_ca: [expect.stringContaining("CA")],
      tls_cert: [expect.stringContaining("client certificate")],
      tls_key: [expect.stringContaining("private key")],
    })
  })

  it("rejects garbage and swapped fields", () => {
    const res = parseTls({ ca: "hello", cert: fx.client.key, key: fx.client.cert })
    expect(Object.keys(res.errors ?? {}).sort()).toEqual(["tls_ca", "tls_cert", "tls_key"])
  })

  it("rejects a corrupted certificate", () => {
    const broken = fx.ca.replace(/\n[A-Za-z0-9+/]{10}/, "\nAAAAAAAAAA")
    expect(parseTls({ ca: broken, ...fx.client }).errors?.tls_ca).toBeDefined()
  })

  it("rejects a key that does not belong to the certificate", () => {
    const res = parseTls({ ca: fx.ca, cert: fx.client.cert, key: fx.rogueClient.key })
    expect(res.errors?.tls_key).toEqual(["This key does not belong to the client certificate"])
  })

  it("rejects passphrase-protected keys", () => {
    const res = parseTls({
      ca: fx.ca,
      cert: fx.client.cert,
      key: "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----",
    })
    expect(res.errors?.tls_key?.[0]).toMatch(/Encrypted/)
  })

  it("never echoes the key in an error", () => {
    const res = parseTls({ ca: fx.ca, cert: fx.client.cert, key: fx.client.key.replace("PRIVATE KEY", "PRIVATE KEX") })
    expect(JSON.stringify(res.errors)).not.toContain(fx.client.key.split("\n")[1])
  })
})
