import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  authenticateApiToken,
  bearerToken,
  createApiToken,
  generateApiToken,
  hashApiToken,
  isApiTokenFormat,
  listApiTokens,
  revokeApiToken,
} from "@/lib/server/auth/api-tokens"
import { openTestDb } from "../helpers/test-db"

describe("API token format", () => {
  it("generates gtk_ tokens with 256 bits of randomness", () => {
    const a = generateApiToken()
    expect(a).toMatch(/^gtk_[A-Za-z0-9_-]{43}$/)
    expect(isApiTokenFormat(a)).toBe(true)
    expect(generateApiToken()).not.toBe(a)
  })

  it("hashes with SHA-256", () => {
    // FIPS 180-2 test vector
    expect(hashApiToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(hashApiToken("gtk_abc")).not.toBe(hashApiToken("gtk_abd"))
  })

  it("reads only well-formed bearer tokens", () => {
    const token = generateApiToken()
    expect(bearerToken(`Bearer ${token}`)).toBe(token)
    expect(bearerToken(`bearer  ${token}`)).toBe(token)
    for (const bad of [null, "", token, `Basic ${token}`, `Bearer ${token}x`, "Bearer gtk_short", `Bearer ${token} extra`]) {
      expect(bearerToken(bad)).toBeNull()
    }
  })
})

describe("API token storage", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>
  let alice = 0
  let bob = 0

  beforeAll(async () => {
    t = await openTestDb()
    alice = await t.addUser("alice", "user")
    bob = await t.addUser("bob", "admin")
  })
  afterAll(() => t?.cleanup())

  it("stores only a hash and a display prefix", async () => {
    const token = await createApiToken(t.db, alice, "ci", null)
    const rows = await t.db.selectFrom("api_tokens").selectAll().execute()
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(rows[0]).toMatchObject({ token_hash: hashApiToken(token), prefix: token.slice(0, 10), user_id: alice })
  })

  it("authenticates as the owner and records the last use", async () => {
    const token = await createApiToken(t.db, alice, "deploy", null)
    expect(await authenticateApiToken(t.db, token)).toEqual({ id: alice, username: "alice", role: "user" })
    const row = (await listApiTokens(t.db, alice)).find((r) => r.name === "deploy")!
    expect(row.last_used_at).not.toBeNull()
    expect(await authenticateApiToken(t.db, generateApiToken())).toBeNull()
    expect(await authenticateApiToken(t.db, "gtk_not-a-token")).toBeNull()
  })

  it("follows the user's current role", async () => {
    const token = await createApiToken(t.db, bob, "admin script", null)
    expect((await authenticateApiToken(t.db, token))?.role).toBe("admin")
    await t.db.updateTable("users").set({ role: "user" }).where("id", "=", bob).execute()
    expect((await authenticateApiToken(t.db, token))?.role).toBe("user")
  })

  it("stops working once expired", async () => {
    const token = await createApiToken(t.db, alice, "short", new Date(Date.now() + 60_000))
    expect(await authenticateApiToken(t.db, token)).not.toBeNull()
    expect(await authenticateApiToken(t.db, token, new Date(Date.now() + 120_000))).toBeNull()
  })

  it("can only be revoked by its owner", async () => {
    const token = await createApiToken(t.db, alice, "revoke me", null)
    const id = (await listApiTokens(t.db, alice)).find((r) => r.name === "revoke me")!.id
    expect(await revokeApiToken(t.db, bob, id)).toBeNull()
    expect(await authenticateApiToken(t.db, token)).not.toBeNull()
    expect(await revokeApiToken(t.db, alice, id)).toBe("revoke me")
    expect(await authenticateApiToken(t.db, token)).toBeNull()
  })

  it("disappears with its user", async () => {
    const token = await createApiToken(t.db, alice, "gone", null)
    await t.db.deleteFrom("users").where("id", "=", alice).execute()
    expect(await authenticateApiToken(t.db, token)).toBeNull()
    expect(await t.db.selectFrom("api_tokens").selectAll().where("user_id", "=", alice).execute()).toEqual([])
  })
})
