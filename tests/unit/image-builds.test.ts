import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { openTestDb } from "../helpers/test-db"

// Build history against a real (migrated) database: rows, pruning, the
// "interrupted" state and the environment scope.
let testDb: Awaited<ReturnType<typeof openTestDb>>
vi.mock("@/lib/server/db", () => ({ getDb: async () => testDb.db }))

const builds = await import("@/lib/server/images/builds")

const options = { tags: ["gantry-test-b-unit:1"], buildArgs: { A: "1" }, labels: {}, target: "", noCache: false, pull: false, push: false }
let env1 = 0
let env2 = 0

beforeAll(async () => {
  testDb = await openTestDb()
  const now = new Date().toISOString()
  for (const name of ["one", "two"]) {
    const r = await testDb.db
      .insertInto("environments")
      .values({ name, type: "socket", url: "/var/run/docker.sock", created_at: now })
      .executeTakeFirstOrThrow()
    if (name === "one") env1 = Number(r.insertId)
    else env2 = Number(r.insertId)
  }
})
afterAll(() => testDb?.cleanup())

describe("build history", () => {
  it("records a build and its outcome, scoped to its environment", async () => {
    const id = await builds.insertBuild({
      environmentId: env1,
      user: { id: null, username: "admin" },
      source: { kind: "git", url: "https://example.com/r.git", ref: "main", context: "", dockerfile: "Dockerfile" },
      sourceSummary: "Git https://example.com/r.git @ main",
      options,
    })
    builds.markActive(id)
    expect((await builds.listBuilds(env1))[0]).toMatchObject({ id, status: "running", tags: ["gantry-test-b-unit:1"], sourceKind: "git" })

    await builds.finishBuild(id, { status: "success", imageId: "sha256:abc", log: "Step 1/1\n" })
    builds.markDone(id)
    const record = await builds.getBuild(env1, id)
    expect(record).toMatchObject({ status: "success", imageId: "sha256:abc", log: "Step 1/1\n", options, finishedAt: expect.any(String) })
    expect(record?.source).toEqual({ kind: "git", url: "https://example.com/r.git", ref: "main", context: "", dockerfile: "Dockerfile" })
    expect(await builds.getBuild(env2, id)).toBeNull()
    expect(await builds.listBuilds(env2)).toEqual([])
  })

  it("shows running builds of a previous process as interrupted", async () => {
    const id = await builds.insertBuild({
      environmentId: env1,
      user: { id: null, username: "admin" },
      source: { kind: "upload", filename: "ctx.tar", dockerfile: "Dockerfile" },
      sourceSummary: "Upload ctx.tar",
      options,
    })
    expect((await builds.getBuild(env1, id))?.status).toBe("interrupted")
  })

  it(`keeps the newest ${100} builds per environment`, async () => {
    const other = await builds.insertBuild({
      environmentId: env2,
      user: { id: null, username: "admin" },
      source: { kind: "editor", dockerfile: "FROM x", files: [] },
      sourceSummary: "Dockerfile editor",
      options,
    })
    let last = 0
    for (let i = 0; i < builds.BUILDS_KEPT + 5; i++) {
      last = await builds.insertBuild({
        environmentId: env1,
        user: { id: null, username: "admin" },
        source: { kind: "editor", dockerfile: "FROM x", files: [] },
        sourceSummary: "Dockerfile editor",
        options,
      })
    }
    const count = await testDb.db
      .selectFrom("image_builds")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("environment_id", "=", env1)
      .executeTakeFirstOrThrow()
    expect(Number(count.n)).toBe(builds.BUILDS_KEPT)
    expect((await builds.listBuilds(env1, 1))[0].id).toBe(last)
    // Other environments keep theirs.
    expect(await builds.getBuild(env2, other)).not.toBeNull()
  })
})
