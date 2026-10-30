import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setUserEnvironments } from "@/lib/server/environment-access"
import { changeRole, deleteUserChecked, invalidateSessions, sessionVersion } from "@/lib/server/users"
import { openTestDb } from "../helpers/test-db"

describe("user lifecycle", () => {
  let t: Awaited<ReturnType<typeof openTestDb>>
  const ids = { root: 0, ops: 0, alice: 0, env: 0 }

  beforeAll(async () => {
    t = await openTestDb()
    ids.root = await t.addUser("root", "admin")
    ids.ops = await t.addUser("ops", "admin")
    ids.alice = await t.addUser("alice", "user")
    ids.env = (await t.db.selectFrom("environments").select("id").executeTakeFirstOrThrow()).id
  })
  afterAll(() => t?.cleanup())

  it("bumps the session version to sign a user out everywhere", async () => {
    expect(await sessionVersion(t.db, ids.alice)).toBe(0)
    await invalidateSessions(t.db, ids.alice)
    expect(await sessionVersion(t.db, ids.alice)).toBe(1)
  })

  it("keeps at least one administrator when two demote each other at once", async () => {
    const results = await Promise.all([changeRole(t.db, ids.root, "user"), changeRole(t.db, ids.ops, "user")])
    expect(results.sort()).toEqual(["last_admin", "ok"])
    const admins = await t.db.selectFrom("users").select("id").where("role", "=", "admin").execute()
    expect(admins).toHaveLength(1)
  })

  it("signs a user out when the role changes, and drops grants on promotion", async () => {
    await setUserEnvironments(t.db, ids.alice, [{ id: ids.env, role: "manager" }])
    const before = await sessionVersion(t.db, ids.alice)
    expect(await changeRole(t.db, ids.alice, "admin")).toBe("ok")
    expect(await sessionVersion(t.db, ids.alice)).toBe(before + 1)
    expect(await t.db.selectFrom("environment_access").selectAll().where("user_id", "=", ids.alice).execute()).toEqual([])
    // Demoted again: no grants come back.
    expect(await changeRole(t.db, ids.alice, "user")).toBe("ok")
    expect(await t.db.selectFrom("environment_access").selectAll().where("user_id", "=", ids.alice).execute()).toEqual([])
    expect(await changeRole(t.db, 999_999, "user")).toBe("not_found")
  })

  it("never deletes the last administrator, even concurrently", async () => {
    const other = await t.addUser("other-admin", "admin")
    const [admin] = await t.db.selectFrom("users").select("id").where("role", "=", "admin").where("id", "!=", other).execute()
    const results = await Promise.all([deleteUserChecked(t.db, admin.id), deleteUserChecked(t.db, other)])
    expect(results.sort()).toEqual(["last_admin", "ok"])
    expect(await t.db.selectFrom("users").select("id").where("role", "=", "admin").execute()).toHaveLength(1)
    expect(await deleteUserChecked(t.db, ids.alice)).toBe("ok")
    expect(await deleteUserChecked(t.db, ids.alice)).toBe("not_found")
  })
})
