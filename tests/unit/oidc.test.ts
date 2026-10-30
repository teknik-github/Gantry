import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  authorizationUrl,
  discover,
  exchangeCode,
  fetchUserinfo,
  generatePkce,
  groupsOf,
  identityFromClaims,
  linkOidcIdentity,
  NO_PASSWORD,
  oidcConfigFromEnv,
  passwordLoginAllowed,
  pkceChallenge,
  randomUrlToken,
  resolveOidcUser,
  safeEqual,
  usernameFromClaims,
  validateIdToken,
  type OidcConfig,
} from "@/lib/server/auth/oidc"
import { verifyPassword } from "@/lib/server/auth/password"
import { startFakeOidc, type FakeOidc } from "../helpers/fake-oidc"
import { openTestDb } from "../helpers/test-db"

describe("OIDC configuration", () => {
  it("is off without issuer and client id", () => {
    expect(oidcConfigFromEnv({})).toBeNull()
  })

  it("refuses a half configuration instead of silently disabling SSO", () => {
    expect(() => oidcConfigFromEnv({ OIDC_ISSUER: "https://id.example.com" })).toThrow(/OIDC_CLIENT_ID/)
    expect(() => oidcConfigFromEnv({ OIDC_ISSUER: "https://id.example.com", OIDC_CLIENT_ID: "g" })).toThrow(/GANTRY_URL/)
    expect(() =>
      oidcConfigFromEnv({ OIDC_ISSUER: "https://id.example.com", OIDC_CLIENT_ID: "g", OIDC_REDIRECT_URL: "javascript:x" })
    ).toThrow()
  })

  it("derives the callback from GANTRY_URL and reads the options", () => {
    const c = oidcConfigFromEnv({
      OIDC_ISSUER: "https://id.example.com/realms/main/",
      OIDC_CLIENT_ID: "gantry",
      OIDC_CLIENT_SECRET: "s3cret",
      GANTRY_URL: "https://gantry.example.com/",
      OIDC_SCOPES: "profile email groups",
      OIDC_ADMIN_GROUPS: "ops, platform-admins",
      OIDC_AUTO_CREATE: "true",
    })!
    expect(c).toMatchObject({
      issuer: "https://id.example.com/realms/main",
      redirectUri: "https://gantry.example.com/auth/oidc/callback",
      scopes: ["openid", "profile", "email", "groups"],
      adminGroups: ["ops", "platform-admins"],
      groupsClaim: "groups",
      usernameClaim: "preferred_username",
      autoCreate: true,
    })
    expect(oidcConfigFromEnv({ OIDC_ISSUER: "https://i", OIDC_CLIENT_ID: "g", GANTRY_URL: "https://g" })!.autoCreate).toBe(false)
  })

  it("keeps the password form for administrators only with PASSWORD_LOGIN=admins", () => {
    const env = { OIDC_ISSUER: "https://i", OIDC_CLIENT_ID: "g", GANTRY_URL: "https://g", PASSWORD_LOGIN: "admins" }
    expect(passwordLoginAllowed("admin", env)).toBe(true)
    expect(passwordLoginAllowed("user", env)).toBe(false)
    // Without SSO the setting can't lock anyone out.
    expect(passwordLoginAllowed("user", { PASSWORD_LOGIN: "admins" })).toBe(true)
    expect(passwordLoginAllowed("user", { ...env, PASSWORD_LOGIN: "all" })).toBe(true)
  })
})

describe("OIDC helpers", () => {
  it("computes PKCE S256 challenges (RFC 7636 appendix B)", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    const { verifier, challenge } = generatePkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(pkceChallenge(verifier))
  })

  it("makes unguessable state and nonce values and compares them in constant time", () => {
    const a = randomUrlToken()
    expect(a).toHaveLength(43)
    expect(randomUrlToken()).not.toBe(a)
    expect(safeEqual(a, a)).toBe(true)
    expect(safeEqual(a, `${a}x`)).toBe(false)
    expect(safeEqual(a, "")).toBe(false)
  })

  it("reads groups from string or list claims", () => {
    expect(groupsOf({ groups: ["a", 1, "b"] }, "groups")).toEqual(["a", "b"])
    expect(groupsOf({ roles: "ops" }, "roles")).toEqual(["ops"])
    expect(groupsOf({}, "groups")).toEqual([])
  })

  it("derives a valid username from the claims", () => {
    expect(usernameFromClaims({ preferred_username: "jane.doe" }, "preferred_username", "s")).toBe("jane.doe")
    expect(usernameFromClaims({ email: "Jörg Müller@example.com" }, "preferred_username", "s")).toBe("Jorg-Muller")
    expect(usernameFromClaims({ preferred_username: "x" }, "preferred_username", "abc")).toMatch(/^sso-[0-9a-f]{8}$/)
    expect(usernameFromClaims({ preferred_username: "a".repeat(100) }, "preferred_username", "s")).toHaveLength(56)
  })

  it("maps the admin group claim to a role only when admin groups are configured", () => {
    const base = { issuer: "https://i", clientId: "g", redirectUri: "https://g/cb", scopes: ["openid"], groupsClaim: "groups", usernameClaim: "preferred_username", autoCreate: true }
    const claims = { sub: "42", preferred_username: "jane", groups: ["ops"] }
    expect(identityFromClaims(claims, { ...base, adminGroups: [] }).admin).toBeNull()
    expect(identityFromClaims(claims, { ...base, adminGroups: ["ops"] })).toEqual({ issuer: "https://i", subject: "42", username: "jane", admin: true })
    expect(identityFromClaims(claims, { ...base, adminGroups: ["root"] }).admin).toBe(false)
  })
})

describe("OIDC against a local provider", () => {
  let idp: FakeOidc
  let config: OidcConfig
  let t: Awaited<ReturnType<typeof openTestDb>>
  const redirectUri = "http://gantry.test/auth/oidc/callback"

  /** Runs the browser part: authorization request → code (the fake provider approves at once). */
  async function authorize(nonce: string, challenge: string) {
    const doc = await discover(config.issuer, { fresh: true })
    const url = authorizationUrl(doc, config, { state: "st-1", nonce, challenge })
    const res = await fetch(url, { redirect: "manual" })
    const back = new URL(res.headers.get("location")!)
    expect(back.searchParams.get("state")).toBe("st-1")
    return { doc, code: back.searchParams.get("code")! }
  }

  beforeAll(async () => {
    idp = await startFakeOidc()
    config = oidcConfigFromEnv({
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: idp.clientId,
      OIDC_CLIENT_SECRET: idp.clientSecret,
      OIDC_REDIRECT_URL: redirectUri,
      OIDC_ADMIN_GROUPS: "gantry-admins",
      OIDC_AUTO_CREATE: "true",
    })!
    t = await openTestDb()
  })
  afterAll(async () => {
    await idp?.close()
    await t?.cleanup()
  })

  it("discovers the endpoints and sends PKCE, state and nonce", async () => {
    const doc = await discover(config.issuer, { fresh: true })
    expect(doc.token_endpoint).toBe(`${idp.issuer}/token`)
    const { challenge } = generatePkce()
    const url = new URL(authorizationUrl(doc, config, { state: "s", nonce: "n", challenge }))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: idp.clientId,
      redirect_uri: redirectUri,
      scope: "openid profile email",
      state: "s",
      nonce: "n",
      code_challenge: challenge,
      code_challenge_method: "S256",
    })
  })

  it("rejects a discovery document for another issuer", async () => {
    await expect(discover(`${idp.issuer}/other`, { fresh: true })).rejects.toThrow()
  })

  it("completes the code flow and validates the ID token", async () => {
    idp.setUser({ sub: "u-100", claims: { preferred_username: "jane", groups: ["staff"] } })
    const { verifier, challenge } = generatePkce()
    const { doc, code } = await authorize("nonce-1", challenge)
    const tokens = await exchangeCode(doc, config, code, verifier)
    const claims = await validateIdToken(tokens.idToken, doc, config, "nonce-1")
    expect(claims).toMatchObject({ sub: "u-100", preferred_username: "jane", iss: idp.issuer, aud: idp.clientId })
    expect(await fetchUserinfo(doc, tokens.accessToken!, "u-100")).toMatchObject({ sub: "u-100" })
    expect(await fetchUserinfo(doc, tokens.accessToken!, "someone-else")).toEqual({})
  })

  it("fails the code exchange with a wrong PKCE verifier or a reused code", async () => {
    const { verifier, challenge } = generatePkce()
    const { doc, code } = await authorize("n", challenge)
    await expect(exchangeCode(doc, config, code, generatePkce().verifier)).rejects.toThrow(/invalid_grant/)
    await expect(exchangeCode(doc, config, code, verifier)).rejects.toThrow(/invalid_grant/)
  })

  it("fails with a wrong client secret", async () => {
    const { verifier, challenge } = generatePkce()
    const { doc, code } = await authorize("n", challenge)
    await expect(exchangeCode(doc, { ...config, clientSecret: "wrong" }, code, verifier)).rejects.toThrow(/invalid_client/)
  })

  it.each([
    ["a wrong nonce", {}, "other-nonce"],
    ["another audience", { aud: "someone-else" }, "n"],
    ["another issuer", { iss: "http://evil.test" }, "n"],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }, "n"],
    ["no nonce", { nonce: undefined }, "n"],
  ])("rejects an ID token with %s", async (_label, tamper, expectedNonce) => {
    idp.setUser({ sub: "u-1" })
    idp.tamperNext(tamper)
    const { verifier, challenge } = generatePkce()
    const { doc, code } = await authorize("n", challenge)
    const { idToken } = await exchangeCode(doc, config, code, verifier)
    await expect(validateIdToken(idToken, doc, config, expectedNonce)).rejects.toThrow()
  })

  it("rejects ID tokens not signed by the provider's keys", async () => {
    const doc = await discover(config.issuer)
    const { SignJWT } = await import("jose")
    const now = Math.floor(Date.now() / 1000)
    const hs = await new SignJWT({ iss: idp.issuer, aud: idp.clientId, sub: "x", nonce: "n", iat: now, exp: now + 60 })
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(idp.clientSecret.padEnd(32, "x")))
    await expect(validateIdToken(hs, doc, config, "n")).rejects.toThrow()
    const good = await idp.sign({ iss: idp.issuer, aud: idp.clientId, sub: "x", nonce: "n", iat: now, exp: now + 60 })
    const [h, p] = good.split(".")
    await expect(validateIdToken(`${h}.${p}.${"A".repeat(342)}`, doc, config, "n")).rejects.toThrow()
    await expect(validateIdToken(good, doc, config, "n")).resolves.toMatchObject({ sub: "x" })
  })

  it("creates a standard user on first login, with no usable password", async () => {
    const identity = identityFromClaims({ sub: "u-200", preferred_username: "jane", groups: ["staff"] }, config)
    const res = await resolveOidcUser(t.db, identity, true)
    expect(res).toMatchObject({ ok: true, created: true, user: { username: "jane", role: "user" } })
    const row = await t.db.selectFrom("users").selectAll().where("username", "=", "jane").executeTakeFirstOrThrow()
    expect(row).toMatchObject({ oidc_issuer: idp.issuer, oidc_subject: "u-200", password_hash: NO_PASSWORD })
    expect(await verifyPassword("", row.password_hash)).toBe(false)
    // Same identity next time: same user.
    expect(await resolveOidcUser(t.db, identity, true)).toMatchObject({ ok: true, created: false, user: { id: row.id } })
  })

  it("never links an existing local user by name or email", async () => {
    const local = await t.addUser("bob", "admin")
    await t.db.updateTable("users").set({ username: "bob" }).where("id", "=", local).execute()
    const identity = identityFromClaims({ sub: "u-300", preferred_username: "bob", email: "bob@example.com" }, config)
    expect(await resolveOidcUser(t.db, identity, false)).toEqual({ ok: false, reason: "not_linked" })
    const res = await resolveOidcUser(t.db, identity, true)
    expect(res).toMatchObject({ ok: true, created: true, user: { username: "bob-2", role: "user" } })
    expect(res.ok && res.user.id).not.toBe(local)
  })

  it("follows the admin group on every login, but never demotes the last administrator", async () => {
    const admin = identityFromClaims({ sub: "u-400", preferred_username: "carol", groups: ["gantry-admins"] }, config)
    const created = await resolveOidcUser(t.db, admin, true)
    expect(created).toMatchObject({ ok: true, user: { role: "admin" } })
    const demoted = await resolveOidcUser(t.db, { ...admin, admin: false }, true)
    expect(demoted).toMatchObject({ ok: true, roleChanged: true, user: { role: "user" } })
    // Only bob is admin now; bob is local. Make carol the only admin, then try to demote her.
    await t.db.updateTable("users").set({ role: "user" }).where("username", "=", "bob").execute()
    await resolveOidcUser(t.db, admin, true)
    expect(await resolveOidcUser(t.db, { ...admin, admin: false }, true)).toMatchObject({ user: { role: "admin" }, roleChanged: false })
  })

  it("links a signed-in user, but not to an identity someone else has", async () => {
    const dave = await t.addUser("dave")
    expect(await linkOidcIdentity(t.db, dave, { issuer: idp.issuer, subject: "u-500" })).toBe("linked")
    expect(await resolveOidcUser(t.db, { issuer: idp.issuer, subject: "u-500", username: "x", admin: null }, false)).toMatchObject({
      ok: true,
      user: { id: dave },
    })
    expect(await linkOidcIdentity(t.db, dave, { issuer: idp.issuer, subject: "u-200" })).toBe("taken")
  })

})
