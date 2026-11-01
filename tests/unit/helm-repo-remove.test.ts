import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { i18nFor } from "@/lib/i18n"
import { SESSION_COOKIE, signSession } from "@/lib/server/auth/token"
import { request, resetRequest } from "../helpers/request-context"
import { openTestDb } from "../helpers/test-db"

vi.mock("next/headers", async () => (await import("../helpers/request-context")).nextHeaders)
vi.mock("next/cache", async () => (await import("../helpers/request-context")).nextCache)
vi.mock("next/navigation", async () => (await import("../helpers/request-context")).nextNavigation)
vi.mock("@/lib/server/db", async () => (await import("../helpers/request-context")).serverDb)

const { removeHelmRepository } = await import("@/app/(app)/kubernetes/helm-actions")

// Removing a chart repository used to look it up with its credentials
// decrypted and swallow any error: one whose credentials can't be decrypted
// (GANTRY_SECRET changed) was reported as already gone and could never be
// removed, although the error message says to add it again.

const k = i18nFor("en").t.kubernetes.actions
const fmt = i18nFor("en").format

let t: Awaited<ReturnType<typeof openTestDb>>
let admin = 0

beforeAll(async () => {
  t = await openTestDb()
  request.db = t.db
  admin = await t.addUser("root", "admin")
})

afterAll(async () => {
  request.db = null
  await t?.cleanup()
})

describe("removeHelmRepository", () => {
  it("removes a repository whose credentials can't be decrypted", async () => {
    resetRequest()
    request.cookies.set(SESSION_COOKIE, await signSession({ uid: admin, role: "admin", ver: 0 }))
    const now = new Date().toISOString()
    const r = await t.db
      .insertInto("helm_repositories")
      .values({ name: "gantry-test-t-broken", url: "https://charts.example.test", credentials: "not-decryptable", created_at: now, updated_at: now })
      .executeTakeFirstOrThrow()
    const id = Number(r.insertId)

    expect(await removeHelmRepository(id)).toEqual({ ok: true, message: fmt(k.repoRemoved, { name: "gantry-test-t-broken" }) })
    expect(await t.db.selectFrom("helm_repositories").select("id").execute()).toEqual([])
    const audit = await t.db.selectFrom("audit_logs").select(["action", "target"]).orderBy("id", "desc").executeTakeFirst()
    expect(audit).toEqual({ action: "kubernetes.helm.repo.remove", target: "gantry-test-t-broken" })

    // Gone now: said so.
    expect(await removeHelmRepository(id)).toEqual({ error: k.repoGone })
  })
})
