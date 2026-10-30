import crypto from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose"

/**
 * A tiny OpenID Connect provider for tests: discovery, an authorization
 * endpoint that signs the configured user in without a login form, a token
 * endpoint that checks the client secret, redirect URI and PKCE verifier,
 * RS256 ID tokens with a JWKS, and userinfo. Shared by the unit tests and the
 * Playwright SSO spec.
 */

export type FakeUser = { sub: string; claims?: Record<string, unknown> }

export type FakeOidc = {
  issuer: string
  clientId: string
  clientSecret: string
  /** Who /authorize signs in next (default: sub "user-1"). */
  setUser(user: FakeUser): void
  /** Overrides claims of the next ID token (e.g. a wrong nonce or audience). */
  tamperNext(claims: Record<string, unknown>): void
  /** Authorization requests received, newest last. */
  requests: URLSearchParams[]
  /** Signs an arbitrary ID token with the provider's key. */
  sign(claims: Record<string, unknown>): Promise<string>
  close(): Promise<void>
}

type Grant = { user: FakeUser; nonce: string; challenge: string; method: string; redirectUri: string; scope: string }

export async function startFakeOidc(opts: { port?: number; clientId?: string; clientSecret?: string } = {}): Promise<FakeOidc> {
  const clientId = opts.clientId ?? "gantry-test"
  const clientSecret = opts.clientSecret ?? "fake-oidc-secret"
  const { publicKey, privateKey } = await generateKeyPair("RS256")
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" }
  const codes = new Map<string, Grant>()
  const accessTokens = new Map<string, FakeUser>()
  let user: FakeUser = { sub: "user-1" }
  let tamper: Record<string, unknown> | null = null
  const requests: URLSearchParams[] = []
  let issuer = ""

  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(privateKey)

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer)
    if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      return json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        userinfo_endpoint: `${issuer}/userinfo`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      })
    }
    if (req.method === "GET" && url.pathname === "/jwks") return json(res, 200, { keys: [jwk] })
    if (req.method === "GET" && url.pathname === "/authorize") {
      const q = url.searchParams
      requests.push(q)
      const redirectUri = q.get("redirect_uri") ?? ""
      if (q.get("client_id") !== clientId || q.get("response_type") !== "code" || !redirectUri) {
        return json(res, 400, { error: "invalid_request" })
      }
      const code = crypto.randomBytes(16).toString("hex")
      codes.set(code, {
        user,
        nonce: q.get("nonce") ?? "",
        challenge: q.get("code_challenge") ?? "",
        method: q.get("code_challenge_method") ?? "",
        redirectUri,
        scope: q.get("scope") ?? "",
      })
      const back = new URL(redirectUri)
      back.searchParams.set("code", code)
      back.searchParams.set("state", q.get("state") ?? "")
      res.writeHead(302, { Location: back.toString() })
      return res.end()
    }
    if (req.method === "POST" && url.pathname === "/token") {
      let raw = ""
      req.on("data", (c) => (raw += c))
      req.on("end", async () => {
        const body = new URLSearchParams(raw)
        let id = body.get("client_id")
        let secret = body.get("client_secret")
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "")
        if (basic) {
          const [u, p] = Buffer.from(basic[1], "base64").toString().split(":")
          id = decodeURIComponent(u.replace(/\+/g, " "))
          secret = decodeURIComponent((p ?? "").replace(/\+/g, " "))
        }
        if (id !== clientId || secret !== clientSecret) return json(res, 401, { error: "invalid_client" })
        const grant = codes.get(body.get("code") ?? "")
        codes.delete(body.get("code") ?? "")
        if (!grant || body.get("grant_type") !== "authorization_code" || body.get("redirect_uri") !== grant.redirectUri) {
          return json(res, 400, { error: "invalid_grant" })
        }
        const verifier = body.get("code_verifier") ?? ""
        const challenge = crypto.createHash("sha256").update(verifier).digest("base64url")
        if (grant.method !== "S256" || challenge !== grant.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE" })
        const now = Math.floor(Date.now() / 1000)
        const accessToken = crypto.randomBytes(16).toString("hex")
        accessTokens.set(accessToken, grant.user)
        const idToken = await sign({
          iss: issuer,
          aud: clientId,
          sub: grant.user.sub,
          iat: now,
          exp: now + 300,
          nonce: grant.nonce,
          ...grant.user.claims,
          ...tamper,
        })
        tamper = null
        json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 300, id_token: idToken })
      })
      return
    }
    if (req.method === "GET" && url.pathname === "/userinfo") {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]
      const who = token ? accessTokens.get(token) : undefined
      if (!who) return json(res, 401, { error: "invalid_token" })
      return json(res, 200, { sub: who.sub, ...who.claims })
    }
    json(res, 404, { error: "not_found" })
  })

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve))
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    issuer,
    clientId,
    clientSecret,
    setUser(u) {
      user = u
    },
    tamperNext(claims) {
      tamper = claims
    },
    requests,
    sign,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
