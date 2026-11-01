import { afterEach, describe, expect, it, vi } from "vitest"

import {
  isCommitSha,
  refMatches,
  validateComposePath,
  validateRef,
  validateRepoUrl,
  WEBHOOK_ID_RE,
} from "@/lib/git-stacks"
import { composeArgs } from "@/lib/server/stacks/compose"
import { checkCredentials, gitConfigEntries, gitEnv, parseCommit, pickRemoteRef, redact } from "@/lib/server/stacks/git"
import { deployFingerprint } from "@/lib/server/stacks/git-records"
import { RedeployQueue } from "@/lib/server/stacks/redeploy-queue"
import { safeEqual } from "@/lib/server/safe-equal"
import { hmacSha256Hex, parseDelivery, verifyDelivery } from "@/lib/server/stacks/webhook"

describe("validateRepoUrl", () => {
  it.each([
    ["https://github.com/owner/repo.git", "https://github.com/owner/repo.git"],
    ["https://gitlab.example.com:8443/group/sub/repo", "https://gitlab.example.com:8443/group/sub/repo"],
    ["  https://GITEA.local/o/r.git ", "https://gitea.local/o/r.git"],
  ])("accepts %s", (input, normalized) => {
    expect(validateRepoUrl(input)).toEqual({ ok: true, value: normalized })
  })

  it.each([
    ["", /required/],
    ["http://github.com/o/r.git", /https/],
    ["git@github.com:o/r.git", /https/],
    ["ssh://git@github.com/o/r.git", /https/],
    ["file:///etc/passwd", /https/],
    ["ext::sh -c touch% /tmp/pwned", /Invalid/],
    ["-uhttps://x/y", /Invalid/],
    ["https://user:token@github.com/o/r.git", /credentials/],
    ["https://token@github.com/o/r.git", /credentials/],
    ["https://github.com/o/r.git?x=1", /query/],
    ["https://github.com/o/r.git#main", /query/],
    ["https://github.com/", /path/],
    ["https://github.com/o/r .git", /Invalid/],
  ])("rejects %j", (input, error) => {
    const res = validateRepoUrl(input)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(error)
  })

  it("allows http only for loopback hosts and only with the test flag", () => {
    expect(validateRepoUrl("http://127.0.0.1:9418/r.git").ok).toBe(false)
    expect(validateRepoUrl("http://127.0.0.1:9418/r.git", { allowHttpLoopback: true }).ok).toBe(true)
    expect(validateRepoUrl("http://localhost/r.git", { allowHttpLoopback: true }).ok).toBe(true)
    expect(validateRepoUrl("http://10.0.0.1/r.git", { allowHttpLoopback: true }).ok).toBe(false)
    expect(validateRepoUrl("http://127.0.0.1.evil.com/r.git", { allowHttpLoopback: true }).ok).toBe(false)
  })
})

describe("validateRef", () => {
  it.each(["main", "release/1.x", "v1.2.3", "refs/heads/main", "refs/tags/v1", "feature_x+y"])("accepts %s", (ref) => {
    expect(validateRef(ref)).toEqual({ ok: true, value: ref })
  })

  it("accepts full commit ids (lowercased)", () => {
    const sha = "A".repeat(40)
    expect(validateRef(sha)).toEqual({ ok: true, value: "a".repeat(40) })
    expect(isCommitSha("b".repeat(64))).toBe(true)
    expect(isCommitSha("abc1234")).toBe(false)
  })

  it.each(["", "-main", "--upload-pack=x", "/main", "main/", "a..b", "a//b", "a.lock", ".hidden", "x/.y", "HEAD", "FETCH_HEAD", "main:other", "a b", "a~1", "a^", "@{u}", "a*"])(
    "rejects %j",
    (ref) => {
      expect(validateRef(ref).ok).toBe(false)
    }
  )
})

describe("validateComposePath", () => {
  it.each([
    ["", "docker-compose.yml"],
    ["compose.yaml", "compose.yaml"],
    ["./deploy/prod.yml", "deploy/prod.yml"],
    ["apps/web/docker-compose.override.YAML", "apps/web/docker-compose.override.YAML"],
  ])("accepts %j", (input, value) => {
    expect(validateComposePath(input)).toEqual({ ok: true, value })
  })

  it.each([
    "/etc/compose.yml",
    "../compose.yml",
    "deploy/../../x.yml",
    "deploy/./x.yml",
    "deploy//x.yml",
    ".git/config.yml",
    "compose.json",
    "compose",
    "-f.yml",
    "dir\\x.yml",
    "with space.yml",
  ])("rejects %j", (input) => {
    expect(validateComposePath(input).ok).toBe(false)
  })
})

describe("refMatches", () => {
  it("matches branches and tags by short name", () => {
    expect(refMatches("main", "refs/heads/main")).toBe(true)
    expect(refMatches("v1", "refs/tags/v1")).toBe(true)
    expect(refMatches("main", "refs/heads/main-2")).toBe(false)
    expect(refMatches("main", "refs/heads/feature/main")).toBe(false)
    expect(refMatches("main", null)).toBe(false)
  })

  it("matches full refs exactly and never matches pinned commits", () => {
    expect(refMatches("refs/heads/main", "refs/heads/main")).toBe(true)
    expect(refMatches("refs/heads/main", "refs/tags/main")).toBe(false)
    expect(refMatches("a".repeat(40), "refs/heads/main")).toBe(false)
  })
})

describe("webhook signatures", () => {
  // From GitHub's "Validating webhook deliveries" documentation.
  const SECRET = "It's a Secret to Everybody"
  const BODY = new TextEncoder().encode("Hello, World!")
  const SIG = "757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
  const url = new URL("https://gantry.example/api/webhooks/stacks/x")

  it("computes the documented HMAC", () => {
    expect(hmacSha256Hex(SECRET, BODY)).toBe(SIG)
  })

  it("verifies GitHub's X-Hub-Signature-256", () => {
    expect(verifyDelivery(new Headers({ "X-Hub-Signature-256": `sha256=${SIG}` }), url, BODY, SECRET)).toEqual({
      ok: true,
      provider: "github",
    })
    const bad = verifyDelivery(new Headers({ "X-Hub-Signature-256": `sha256=${SIG.replace(/^7/, "8")}` }), url, BODY, SECRET)
    expect(bad).toMatchObject({ ok: false, provider: "github" })
    // Same signature, different body.
    expect(verifyDelivery(new Headers({ "X-Hub-Signature-256": `sha256=${SIG}` }), url, new TextEncoder().encode("Hello, World?"), SECRET).ok).toBe(false)
    // Without the sha256= prefix it is not a GitHub signature.
    expect(verifyDelivery(new Headers({ "X-Hub-Signature-256": SIG }), url, BODY, SECRET).ok).toBe(false)
  })

  it("verifies Gitea and Forgejo signatures (hex HMAC, no prefix)", () => {
    expect(verifyDelivery(new Headers({ "X-Gitea-Signature": SIG }), url, BODY, SECRET)).toEqual({ ok: true, provider: "gitea" })
    expect(verifyDelivery(new Headers({ "X-Forgejo-Signature": SIG.toUpperCase() }), url, BODY, SECRET)).toEqual({ ok: true, provider: "gitea" })
    expect(verifyDelivery(new Headers({ "X-Gitea-Signature": "00" + SIG.slice(2) }), url, BODY, SECRET).ok).toBe(false)
    // Gitea also sends GitHub's header; its own wins.
    expect(
      verifyDelivery(new Headers({ "X-Gitea-Signature": SIG, "X-Hub-Signature-256": "sha256=bogus" }), url, BODY, SECRET)
    ).toEqual({ ok: true, provider: "gitea" })
  })

  it("compares GitLab's X-Gitlab-Token with the secret", () => {
    expect(verifyDelivery(new Headers({ "X-Gitlab-Token": SECRET }), url, BODY, SECRET)).toEqual({ ok: true, provider: "gitlab" })
    expect(verifyDelivery(new Headers({ "X-Gitlab-Token": `${SECRET}x` }), url, BODY, SECRET)).toMatchObject({ ok: false, provider: "gitlab" })
    expect(verifyDelivery(new Headers({ "X-Gitlab-Token": "" }), url, BODY, SECRET).ok).toBe(false)
  })

  it("accepts a generic token in a header, as a bearer token or in the query", () => {
    expect(verifyDelivery(new Headers({ "X-Gantry-Token": SECRET }), url, BODY, SECRET)).toEqual({ ok: true, provider: "generic" })
    expect(verifyDelivery(new Headers({ Authorization: `Bearer ${SECRET}` }), url, BODY, SECRET).ok).toBe(true)
    const withQuery = new URL(url)
    withQuery.searchParams.set("token", SECRET)
    expect(verifyDelivery(new Headers(), withQuery, BODY, SECRET).ok).toBe(true)
    withQuery.searchParams.set("token", "nope")
    expect(verifyDelivery(new Headers(), withQuery, BODY, SECRET).ok).toBe(false)
  })

  it("rejects deliveries without any signature or token", () => {
    expect(verifyDelivery(new Headers(), url, BODY, SECRET)).toEqual({ ok: false, provider: null, reason: "no signature or token" })
  })

  it("compares in constant time over digests", () => {
    expect(safeEqual("abc", "abc")).toBe(true)
    expect(safeEqual("abc", "abd")).toBe(false)
    expect(safeEqual("abc", "abcd")).toBe(false)
    expect(safeEqual("", "")).toBe(true)
  })
})

describe("parseDelivery", () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))

  it("reads GitHub pushes, pings and other events", () => {
    const push = parseDelivery("github", new Headers({ "X-GitHub-Event": "push" }), enc({ ref: "refs/heads/main", after: "a".repeat(40) }))
    expect(push).toEqual({ kind: "push", ref: "refs/heads/main", deleted: false, after: "a".repeat(40) })
    expect(parseDelivery("github", new Headers({ "X-GitHub-Event": "ping" }), enc({ zen: "x" }))).toEqual({ kind: "ping" })
    expect(parseDelivery("github", new Headers({ "X-GitHub-Event": "issues" }), enc({}))).toEqual({ kind: "other", event: "issues" })
  })

  it("reads form-encoded GitHub payloads", () => {
    const body = new TextEncoder().encode(`payload=${encodeURIComponent(JSON.stringify({ ref: "refs/heads/dev" }))}`)
    const headers = new Headers({ "X-GitHub-Event": "push", "Content-Type": "application/x-www-form-urlencoded" })
    expect(parseDelivery("github", headers, body)).toMatchObject({ kind: "push", ref: "refs/heads/dev" })
  })

  it("detects branch deletions", () => {
    const res = parseDelivery("gitlab", new Headers({ "X-Gitlab-Event": "Push Hook" }), enc({ ref: "refs/heads/main", after: "0".repeat(40) }))
    expect(res).toMatchObject({ kind: "push", deleted: true })
    expect(parseDelivery("github", new Headers({ "X-GitHub-Event": "push" }), enc({ ref: "refs/heads/x", deleted: true }))).toMatchObject({ deleted: true })
  })

  it("handles GitLab tag pushes and Gitea events", () => {
    expect(parseDelivery("gitlab", new Headers({ "X-Gitlab-Event": "Tag Push Hook" }), enc({ ref: "refs/tags/v1" }))).toMatchObject({ ref: "refs/tags/v1" })
    expect(parseDelivery("gitlab", new Headers({ "X-Gitlab-Event": "Merge Request Hook" }), enc({}))).toMatchObject({ kind: "other" })
    expect(parseDelivery("gitea", new Headers({ "X-Forgejo-Event": "push" }), enc({ ref: "refs/heads/main" }))).toMatchObject({ kind: "push" })
    expect(parseDelivery("gitea", new Headers({ "X-Gitea-Event": "release" }), enc({}))).toMatchObject({ kind: "other" })
  })

  it("lets generic triggers omit the body or the ref", () => {
    expect(parseDelivery("generic", new Headers(), new Uint8Array())).toEqual({ kind: "push", ref: null, deleted: false, after: null })
    expect(parseDelivery("generic", new Headers(), enc({ ref: "refs/heads/x" }))).toMatchObject({ ref: "refs/heads/x" })
    expect(() => parseDelivery("generic", new Headers(), new TextEncoder().encode("{oops"))).toThrow(SyntaxError)
  })

  it("rejects provider payloads without a ref or with broken JSON", () => {
    expect(() => parseDelivery("github", new Headers({ "X-GitHub-Event": "push" }), enc({}))).toThrow(SyntaxError)
    expect(() => parseDelivery("gitea", new Headers(), new TextEncoder().encode("not json"))).toThrow(SyntaxError)
  })
})

describe("git credentials handling", () => {
  const TOKEN = "ghp_SuperSecretToken1234567890"

  it("never puts the token in the git config or environment", () => {
    const entries = gitConfigEntries({ credentialFile: "/tmp/gantry-git-abc/credentials", allowHttp: false })
    const env = gitEnv("/tmp/gantry-git-abc", entries, {
      PATH: "/usr/bin",
      GANTRY_SECRET: "x".repeat(40),
      MYSQL_PASSWORD: "pw",
    } as unknown as NodeJS.ProcessEnv)
    const all = JSON.stringify(env)
    expect(all).not.toContain(TOKEN)
    // Gantry's own secrets don't reach git either.
    expect(all).not.toContain("GANTRY_SECRET")
    expect(all).not.toContain("MYSQL_PASSWORD")
    expect(env.GIT_TERMINAL_PROMPT).toBe("0")
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1")
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null")
    // Helpers are reset first, then only ours (which reads the private file).
    const helpers = entries.filter(([k]) => k === "credential.helper").map(([, v]) => v)
    expect(helpers[0]).toBe("")
    expect(helpers[1]).toContain("/tmp/gantry-git-abc/credentials")
    expect(entries).toContainEqual(["protocol.allow", "never"])
    expect(entries).toContainEqual(["protocol.https.allow", "always"])
    expect(entries.some(([k]) => k === "protocol.http.allow")).toBe(false)
    expect(Number(env.GIT_CONFIG_COUNT)).toBe(entries.length)
  })

  it("allows http only when asked to (tests on loopback)", () => {
    expect(gitConfigEntries({ credentialFile: null, allowHttp: true })).toContainEqual(["protocol.http.allow", "always"])
    expect(gitConfigEntries({ credentialFile: null, allowHttp: false }).filter(([k]) => k === "credential.helper")).toEqual([
      ["credential.helper", ""],
    ])
  })

  it("redacts secrets from output", () => {
    expect(redact(`fatal: could not read from https://x/${TOKEN}/r.git`, [TOKEN])).toBe("fatal: could not read from https://x/***/r.git")
    expect(redact("abc", ["ab"])).toBe("abc")
  })

  it("checks usernames and tokens for the line-based credential protocol", () => {
    expect(checkCredentials("", "")).toBeNull()
    expect(checkCredentials("oauth2", TOKEN)).toBeNull()
    expect(checkCredentials("", TOKEN)).toMatch(/username/)
    expect(checkCredentials("me", "")).toMatch(/token/)
    expect(checkCredentials("me\npassword=x", TOKEN)).not.toBeNull()
    expect(checkCredentials("me", "tok\nen")).not.toBeNull()
    expect(checkCredentials("a:b", TOKEN)).not.toBeNull()
  })
})

describe("git output parsing", () => {
  it("parses a commit line", () => {
    const sha = "c".repeat(40)
    expect(parseCommit(`${sha}\0Fix the thing\0Ada\x002026-01-02T03:04:05+00:00\n`)).toEqual({
      sha,
      subject: "Fix the thing",
      author: "Ada",
      date: "2026-01-02T03:04:05+00:00",
    })
    expect(parseCommit("garbage")).toBeNull()
  })

  it("picks the branch, else the peeled tag, from ls-remote", () => {
    const a = "a".repeat(40)
    const b = "b".repeat(40)
    const c = "c".repeat(40)
    expect(pickRemoteRef(`${a}\trefs/heads/main\n${b}\trefs/tags/main\n`, "main")).toBe(a)
    expect(pickRemoteRef(`${b}\trefs/tags/v1\n${c}\trefs/tags/v1^{}\n`, "v1")).toBe(c)
    expect(pickRemoteRef(`${b}\trefs/tags/v1\n`, "v1")).toBe(b)
    expect(pickRemoteRef(`${a}\trefs/heads/main\n`, "refs/heads/main")).toBe(a)
    expect(pickRemoteRef("", "main")).toBeNull()
  })

  it("fingerprints commit, compose path and .env", () => {
    const base = deployFingerprint("a".repeat(40), "A=1\n", "compose.yml")
    expect(deployFingerprint("a".repeat(40), "A=1\n", "compose.yml")).toBe(base)
    expect(deployFingerprint("b".repeat(40), "A=1\n", "compose.yml")).not.toBe(base)
    expect(deployFingerprint("a".repeat(40), "A=2\n", "compose.yml")).not.toBe(base)
    expect(deployFingerprint("a".repeat(40), "A=1\n", "other.yml")).not.toBe(base)
  })
})

describe("composeArgs with a Git checkout", () => {
  it("points -f at the file inside the checkout", () => {
    const args = composeArgs("web", ["up", "-d"], { compose: "repo/deploy/compose.yaml", env: ".env" })
    expect(args.slice(args.indexOf("-f"), args.indexOf("-f") + 4)).toEqual(["-f", "repo/deploy/compose.yaml", "--env-file", ".env"])
  })

  it.each(["/etc/x.yml", "repo/../../x.yml", "-x.yml"])("refuses %j", (file) => {
    expect(() => composeArgs("web", ["up"], { compose: file, env: ".env" })).toThrow()
  })
})

describe("webhook ids", () => {
  it("are 32 base64url characters", () => {
    expect(WEBHOOK_ID_RE.test("a".repeat(32))).toBe(true)
    expect(WEBHOOK_ID_RE.test("a".repeat(31))).toBe(false)
    expect(WEBHOOK_ID_RE.test(`${"a".repeat(31)}/`)).toBe(false)
  })
})

describe("RedeployQueue", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("merges a burst of requests into one run", async () => {
    vi.useFakeTimers()
    const runs: string[][] = []
    const q = new RedeployQueue<number>(async (_k, reasons) => {
      runs.push(reasons)
    }, 1000)
    expect(q.request(1, "a")).toBe("scheduled")
    expect(q.request(1, "b")).toBe("merged")
    expect(q.request(1, "c")).toBe("merged")
    expect(q.pending(1)).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toEqual([["a", "b", "c"]])
    expect(q.pending(1)).toBe(false)
  })

  it("queues exactly one follow-up run for requests during a run", async () => {
    vi.useFakeTimers()
    const runs: string[][] = []
    let release!: () => void
    const q = new RedeployQueue<number>(async (_k, reasons) => {
      runs.push(reasons)
      if (runs.length === 1) await new Promise<void>((r) => (release = r))
    }, 100)
    q.request(1, "first")
    await vi.advanceTimersByTimeAsync(100)
    expect(runs).toHaveLength(1)
    expect(q.request(1, "second")).toBe("queued")
    expect(q.request(1, "third")).toBe("merged")
    release()
    await vi.advanceTimersByTimeAsync(100)
    expect(runs).toEqual([["first"], ["second", "third"]])
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toHaveLength(2)
    expect(q.pending(1)).toBe(false)
  })

  it("keeps stacks independent and survives a failing run", async () => {
    vi.useFakeTimers()
    const seen: number[] = []
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const q = new RedeployQueue<number>(async (k) => {
      seen.push(k)
      if (k === 1) throw new Error("boom")
    }, 10)
    q.request(1, "x")
    q.request(2, "y")
    await vi.advanceTimersByTimeAsync(10)
    expect(seen.sort()).toEqual([1, 2])
    expect(q.request(1, "again")).toBe("scheduled")
    errors.mockRestore()
  })
})
