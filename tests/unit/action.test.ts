import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { i18nFor } from "@/lib/i18n"
import { LOCALE_COOKIE } from "@/lib/i18n/config"
import { ENVIRONMENT_SWITCHED, NO_ENVIRONMENT_ASSIGNED } from "@/lib/messages"
import type { EnvironmentRole } from "@/lib/permissions"
import { createApiToken } from "@/lib/server/auth/api-tokens"
import { API_AUTH_HEADER, apiAuthMarker, ENV_COOKIE, SESSION_COOKIE, signSession } from "@/lib/server/auth/token"
import { DockerError } from "@/lib/server/docker/client"
import { KubeError } from "@/lib/server/kubernetes/client"
import { request, resetRequest, nextCache, RedirectError } from "../helpers/request-context"
import { openTestDb } from "../helpers/test-db"

vi.mock("next/headers", async () => (await import("../helpers/request-context")).nextHeaders)
vi.mock("next/cache", async () => (await import("../helpers/request-context")).nextCache)
vi.mock("next/navigation", async () => (await import("../helpers/request-context")).nextNavigation)
vi.mock("@/lib/server/db", async () => (await import("../helpers/request-context")).serverDb)

const { authorize, expectedEnvironment, inEnvironment, requirePermission, runAction, runBulkAction, UserError } = await import(
  "@/lib/server/action"
)

// lib/server/action.ts: who may run a Server Action (global admin, or a role
// in the current environment), the environment pin, and what the user sees
// when the action fails. Runs against a throwaway database through the real
// DAL (signed session cookie -> users row -> grants).

const en = i18nFor("en").t
const id = i18nFor("id").t

let t: Awaited<ReturnType<typeof openTestDb>>
const users = { admin: 0, viewer: 0, operator: 0, manager: 0, nobody: 0 }
const envs = { one: 0, two: 0 }

async function signIn(uid: number, role: "admin" | "user") {
  request.cookies.set(SESSION_COOKIE, await signSession({ uid, role, ver: 0 }))
}

async function audits() {
  return request.db!.selectFrom("audit_logs").select(["username", "action", "target"]).orderBy("id").execute()
}

beforeAll(async () => {
  t = await openTestDb()
  request.db = t.db
  users.admin = await t.addUser("root", "admin")
  users.viewer = await t.addUser("vera")
  users.operator = await t.addUser("otto")
  users.manager = await t.addUser("mia")
  users.nobody = await t.addUser("nob")
  const now = new Date().toISOString()
  for (const name of ["one", "two"] as const) {
    const r = await t.db
      .insertInto("environments")
      .values({ name, type: "socket", url: `/nonexistent/gantry-test-t-${name}.sock`, created_at: now })
      .executeTakeFirstOrThrow()
    envs[name] = Number(r.insertId)
  }
  const grant = (user_id: number, environment_id: number, role: EnvironmentRole) => ({ user_id, environment_id, role, created_at: now })
  await t.db
    .insertInto("environment_access")
    .values([
      grant(users.viewer, envs.one, "viewer"),
      grant(users.operator, envs.one, "operator"),
      grant(users.manager, envs.one, "manager"),
      // Mia only views the second environment.
      grant(users.manager, envs.two, "viewer"),
    ])
    .execute()
})

afterAll(async () => {
  request.db = null
  await t?.cleanup()
})

beforeEach(() => resetRequest())
afterEach(() => vi.restoreAllMocks())

describe("authorize", () => {
  it("refuses requests without a valid session", async () => {
    expect(await authorize("user")).toEqual({ error: en.common.errors.sessionExpired })
    request.cookies.set(SESSION_COOKIE, "garbage")
    expect(await authorize("view")).toEqual({ error: en.common.errors.sessionExpired })
    // A session of an older version (signed out everywhere) no longer counts.
    request.cookies.set(SESSION_COOKIE, await signSession({ uid: users.viewer, role: "user", ver: 1 }))
    expect(await authorize("user")).toEqual({ error: en.common.errors.sessionExpired })
    // Nor one of a deleted user.
    request.cookies.set(SESSION_COOKIE, await signSession({ uid: 9999, role: "admin", ver: 0 }))
    expect(await authorize("admin")).toEqual({ error: en.common.errors.sessionExpired })
  })

  it("never accepts an API token (Server Actions are cookie-only)", async () => {
    const token = await createApiToken(t.db, users.admin, "ci", null)
    request.headers.set("authorization", `Bearer ${token}`)
    request.headers.set(API_AUTH_HEADER, apiAuthMarker())
    expect(await authorize("user")).toEqual({ error: en.common.errors.sessionExpired })
    expect(await authorize("admin")).toEqual({ error: en.common.errors.sessionExpired })
  })

  it("answers in the user's language", async () => {
    request.cookies.set(LOCALE_COOKIE, "id")
    expect(await authorize("user")).toEqual({ error: id.common.errors.sessionExpired })
  })

  it("'user' needs only a session; 'admin' needs an administrator", async () => {
    await signIn(users.nobody, "user")
    const res = await authorize("user")
    expect(res).toMatchObject({ user: { id: users.nobody, username: "nob", role: "user", via: "session" }, environment: null })
    expect(await authorize("admin")).toEqual({ error: en.common.errors.adminsOnly })
    await signIn(users.admin, "admin")
    expect(await authorize("admin")).toMatchObject({ user: { id: users.admin, role: "admin" }, environment: null })
  })

  it("uses the role from the database, not the one in the cookie", async () => {
    // A cookie claiming "admin" for a standard user gives nothing more.
    request.cookies.set(SESSION_COOKIE, await signSession({ uid: users.viewer, role: "admin", ver: 0 }))
    expect(await authorize("admin")).toEqual({ error: en.common.errors.adminsOnly })
  })

  it.each([
    ["viewer", { view: true, operate: false, manage: false }],
    ["operator", { view: true, operate: true, manage: false }],
    ["manager", { view: true, operate: true, manage: true }],
  ] as const)("a %s in the current environment", async (who, expected) => {
    await signIn(users[who], "user")
    for (const need of ["view", "operate", "manage"] as const) {
      const res = await authorize(need)
      if (expected[need]) {
        expect(res, need).toMatchObject({ user: { id: users[who] }, environment: { id: envs.one } })
      } else {
        const role = need === "operate" ? en.common.roles.operator : en.common.roles.manager
        expect(res, need).toEqual({
          error: en.common.errors.needsRole.replace("{role}", role.toLowerCase()).replace("{environment}", "one"),
        })
      }
    }
  })

  it("checks the role in the selected environment (env cookie)", async () => {
    await signIn(users.manager, "user")
    expect(await authorize("manage")).toMatchObject({ environment: { id: envs.one } })
    request.cookies.set(ENV_COOKIE, String(envs.two))
    expect(await authorize("view")).toMatchObject({ environment: { id: envs.two } })
    expect("error" in (await authorize("operate"))).toBe(true)
    // An environment the user may not use falls back to the first allowed one.
    await signIn(users.viewer, "user")
    expect(await authorize("view")).toMatchObject({ environment: { id: envs.one } })
  })

  it("refuses users without any environment", async () => {
    await signIn(users.nobody, "user")
    for (const need of ["view", "operate", "manage"] as const) {
      expect(await authorize(need)).toEqual({ error: en.common.environment.noneAssigned })
    }
  })

  it("gives administrators every right in every environment", async () => {
    await signIn(users.admin, "admin")
    request.cookies.set(ENV_COOKIE, String(envs.two))
    for (const need of ["view", "operate", "manage"] as const) {
      expect(await authorize(need)).toMatchObject({ user: { id: users.admin }, environment: { id: envs.two } })
    }
  })

  it("inEnvironment: refuses when the selected environment changed since the page was rendered", async () => {
    await signIn(users.manager, "user")
    expect(await authorize(inEnvironment("manage", envs.one))).toMatchObject({ environment: { id: envs.one }, expectedId: envs.one })
    expect(await authorize(inEnvironment("view", envs.two))).toEqual({ error: en.common.environment.switched })
    // Without an id (old clients, API callers) only the role counts.
    expect(await authorize(inEnvironment("manage", undefined))).toMatchObject({ environment: { id: envs.one } })
    // Admins are pinned too.
    await signIn(users.admin, "admin")
    expect(await authorize(inEnvironment("view", envs.two))).toEqual({ error: en.common.environment.switched })
    // A user without environments is told so rather than "switched".
    await signIn(users.nobody, "user")
    expect(await authorize(inEnvironment("view", envs.one))).toEqual({ error: en.common.environment.noneAssigned })
  })

  it("expectedEnvironment parses only positive integer ids", () => {
    expect(expectedEnvironment(3)).toBe(3)
    expect(expectedEnvironment("12")).toBe(12)
    for (const bad of [undefined, null, "", "0", 0, -1, "1.5", 1.5, "1e3", " 2", "abc", {}, Number.MAX_SAFE_INTEGER + 1]) {
      expect(expectedEnvironment(bad), String(bad)).toBeUndefined()
    }
  })
})

describe("requirePermission", () => {
  it("sends users without the role to the dashboard, and signed-out ones to /login", async () => {
    await expect(requirePermission("view")).rejects.toEqual(new RedirectError("/login"))
    await signIn(users.viewer, "user")
    await expect(requirePermission("view")).resolves.toMatchObject({ id: users.viewer })
    await expect(requirePermission("operate")).rejects.toEqual(new RedirectError("/dashboard"))
  })
})

describe("runAction", () => {
  it("runs, audits, refreshes and returns the message", async () => {
    await signIn(users.operator, "user")
    const fn = vi.fn(async ({ user }: { user: { id: number } }) => `done by ${user.id}`)
    const before = (await audits()).length
    expect(await runAction("operate", "container.restart", "web-1", fn)).toEqual({ ok: true, message: `done by ${users.operator}` })
    expect(fn).toHaveBeenCalledOnce()
    expect((await audits()).slice(before)).toEqual([{ username: "otto", action: "container.restart", target: "web-1" }])
    expect(nextCache.refresh).toHaveBeenCalledOnce()
    // No message: ok without one.
    expect(await runAction("view", "x.y", "z", async () => {})).toEqual({ ok: true, message: undefined })
  })

  it("does not run, audit or refresh when the user may not", async () => {
    await signIn(users.viewer, "user")
    const fn = vi.fn(async () => "never")
    const before = (await audits()).length
    const res = await runAction("manage", "container.remove", "web-1", fn)
    expect(res).toEqual({ error: expect.stringContaining("manager") })
    expect(await runAction("admin", "user.create", "x", fn)).toEqual({ error: en.common.errors.adminsOnly })
    expect(await runAction(inEnvironment("view", envs.two), "x", "y", fn)).toEqual({ error: en.common.environment.switched })
    resetRequest()
    expect(await runAction("user", "account.update", "x", fn)).toEqual({ error: en.common.errors.sessionExpired })
    expect(fn).not.toHaveBeenCalled()
    expect(await audits()).toHaveLength(before)
    expect(nextCache.refresh).not.toHaveBeenCalled()
  })

  it("shows UserError, DockerError and KubeError messages, translating the known ones", async () => {
    await signIn(users.manager, "user")
    const fail = (err: Error) => runAction("manage", "x", "y", async () => Promise.reject(err))
    expect(await fail(new UserError("Name already taken"))).toEqual({ error: "Name already taken" })
    expect(await fail(new DockerError("No such container: abc", 404))).toEqual({ error: "No such container: abc" })
    expect(await fail(new KubeError('pods "x" not found', 404, "NotFound"))).toEqual({ error: 'pods "x" not found' })
    expect(await fail(new DockerError(ENVIRONMENT_SWITCHED, 409))).toEqual({ error: en.common.environment.switched })
    request.cookies.set(LOCALE_COOKIE, "id")
    expect(await fail(new DockerError(NO_ENVIRONMENT_ASSIGNED, 403))).toEqual({ error: id.common.environment.noneAssigned })
    expect(await fail(new UserError("Something specific"))).toEqual({ error: "Something specific" })
  })

  it("hides unexpected errors behind a generic message, logs them, and neither audits nor refreshes", async () => {
    await signIn(users.manager, "user")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const before = (await audits()).length
    const secret = new Error("ER_ACCESS_DENIED for user 'gantry'@'10.0.0.5' (password: YES)")
    const res = await runAction("manage", "stack.deploy", "web", async () => Promise.reject(secret))
    expect(res).toEqual({ error: en.common.errors.somethingWentWrong })
    expect(JSON.stringify(res)).not.toContain("ER_ACCESS_DENIED")
    expect(log).toHaveBeenCalledWith("[gantry] action stack.deploy failed", secret)
    expect(await audits()).toHaveLength(before)
    expect(nextCache.refresh).not.toHaveBeenCalled()
    // Not even when something that isn't an Error is thrown.
    expect(await runAction("manage", "x", "y", async () => Promise.reject("raw string"))).toEqual({ error: en.common.errors.somethingWentWrong })
  })

  it("gives fn a Docker client for the pinned environment", async () => {
    await signIn(users.manager, "user")
    let url: string | undefined
    await runAction(inEnvironment("manage", envs.one), "x", "y", async ({ docker }) => {
      url = (await docker()).target.url
    })
    expect(url).toBe("/nonexistent/gantry-test-t-one.sock")
    // Selected in another tab between the check and fn asking for the client: refused.
    const res = await runAction(inEnvironment("view", envs.one), "x", "y", async ({ docker }) => {
      request.cookies.set(ENV_COOKIE, String(envs.two))
      await docker()
    })
    expect(res).toEqual({ error: en.common.environment.switched })
  })
})

describe("runBulkAction", () => {
  const opts = { verb: "Stopped", noun: "container", label: (s: string) => s }

  it("checks permissions once, audits each success and reports failures", async () => {
    await signIn(users.operator, "user")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const before = (await audits()).length
    const res = await runBulkAction("operate", "container.stop", ["a", "b", "c"], opts, async (item) => {
      if (item === "b") throw new DockerError("is not running", 409)
      if (item === "c") throw new Error("socket hang up at 10.0.0.5")
    })
    expect(res.ok).toBeFalsy()
    expect(res.error).toContain("is not running")
    expect(res.error).not.toContain("10.0.0.5")
    expect(log).toHaveBeenCalledWith("[gantry] action container.stop failed", expect.any(Error))
    expect((await audits()).slice(before)).toEqual([{ username: "otto", action: "container.stop", target: "a" }])
    expect(nextCache.refresh).toHaveBeenCalledOnce()
  })

  it("refuses without the role, an empty selection or too many items", async () => {
    await signIn(users.viewer, "user")
    const fn = vi.fn(async () => {})
    expect((await runBulkAction("operate", "x", ["a"], opts, fn)).error).toContain("operator")
    await signIn(users.operator, "user")
    expect(await runBulkAction("operate", "x", [], opts, fn)).toEqual({ error: en.common.errors.nothingSelected })
    expect((await runBulkAction("operate", "x", Array.from({ length: 1000 }, (_, i) => String(i)), opts, fn)).error).toBeTruthy()
    expect(fn).not.toHaveBeenCalled()
  })
})
