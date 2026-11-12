import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ContainerSummary } from "@/lib/server/docker/api"

const pullAndRecreate = vi.fn()
vi.mock("@/lib/server/docker/recreate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/docker/recreate")>()),
  pullAndRecreate: (...args: unknown[]) => pullAndRecreate(...args),
}))

const { runExternalOperation, ExternalProjectError, composeProjectSchema } = await import("@/lib/server/stacks/external")

const PROJECT = "com.docker.compose.project"

function container(id: string, name: string, state: string, created: number, project = "shop"): ContainerSummary {
  return {
    Id: id.padEnd(64, "0"),
    Names: [`/${name}`],
    State: state,
    Created: created,
    Labels: { [PROJECT]: project },
  } as unknown as ContainerSummary
}

function fakeApi(containers: ContainerSummary[]) {
  const calls: string[] = []
  const api = {
    listContainers: vi.fn(async () => containers),
    containerAction: vi.fn(async (id: string, act: string) => {
      calls.push(`${act} ${id.slice(0, 2)}`)
    }),
    removeContainer: vi.fn(async (id: string, opts: { force?: boolean; volumes?: boolean }) => {
      calls.push(`rm ${id.slice(0, 2)}${opts.volumes ? " -v" : ""}`)
    }),
    listNetworks: vi.fn(async () => [
      { Id: "n1", Name: "shop_default", Labels: { [PROJECT]: "shop" } },
      { Id: "n2", Name: "other_default", Labels: { [PROJECT]: "other" } },
    ]),
    removeNetwork: vi.fn(async (id: string) => {
      calls.push(`rm-net ${id}`)
    }),
    listVolumes: vi.fn(async () => [
      { Name: "shop_data", Labels: { [PROJECT]: "shop" } },
      { Name: "keep", Labels: null },
    ]),
    removeVolume: vi.fn(async (name: string) => {
      calls.push(`rm-vol ${name}`)
    }),
  }
  return { api: api as never, calls }
}

// db (oldest) <- api <- web (newest); "x1" belongs to another project.
const db = container("a1", "shop-db-1", "running", 100)
const api = container("b1", "shop-api-1", "exited", 200)
const web = container("c1", "shop-web-1", "running", 300)
const other = container("d1", "other-app-1", "running", 50, "other")

beforeEach(() => {
  pullAndRecreate.mockReset()
})

describe("runExternalOperation", () => {
  it("starts only stopped containers, oldest first", async () => {
    const { api: fake, calls } = fakeApi([web, other, api, db])
    const res = await runExternalOperation(fake, "shop", "start")
    expect(calls).toEqual(["start b1"])
    expect(res).toEqual({ done: 1, unchanged: 0, failures: [] })
  })

  it("stops running containers newest first and leaves other projects alone", async () => {
    const { api: fake, calls } = fakeApi([db, other, web, api])
    await runExternalOperation(fake, "shop", "stop")
    expect(calls).toEqual(["stop c1", "stop a1"])
  })

  it("restarts every container of the project", async () => {
    const { api: fake, calls } = fakeApi([web, db, api])
    await runExternalOperation(fake, "shop", "restart")
    expect(calls).toEqual(["restart a1", "restart b1", "restart c1"])
  })

  it("keeps going after a failure and names it", async () => {
    const { api: fake } = fakeApi([db, web])
    ;(fake as { containerAction: ReturnType<typeof vi.fn> }).containerAction.mockImplementation(async (id: string) => {
      if (id.startsWith("c1")) throw new Error("boom")
    })
    const res = await runExternalOperation(fake, "shop", "restart")
    expect(res.done).toBe(1)
    expect(res.failures).toEqual(["shop-web-1: boom"])
  })

  it("redeploy pulls and recreates each container, counting the up-to-date ones", async () => {
    pullAndRecreate.mockImplementation(async (_api: unknown, { id }: { id: string }) =>
      id.startsWith("a1") ? { updated: false, image: "postgres:17" } : { updated: true, id: "new", name: "x", warnings: [] }
    )
    const { api: fake } = fakeApi([web, db, api])
    const res = await runExternalOperation(fake, "shop", "redeploy")
    expect(pullAndRecreate.mock.calls.map((c) => (c[1] as { id: string }).id.slice(0, 2))).toEqual(["a1", "b1", "c1"])
    expect(res).toEqual({ done: 2, unchanged: 1, failures: [] })
  })

  it("remove stops, removes containers and the project's networks; volumes only when asked", async () => {
    const { api: fake, calls } = fakeApi([db, web, api])
    await runExternalOperation(fake, "shop", "remove")
    expect(calls).toEqual(["stop c1", "stop a1", "rm c1", "rm b1", "rm a1", "rm-net n1"])

    const second = fakeApi([db])
    await runExternalOperation(second.api, "shop", "remove", { removeVolumes: true })
    expect(second.calls).toEqual(["stop a1", "rm a1 -v", "rm-net n1", "rm-vol shop_data"])
  })

  it("refuses unknown projects and anything but start on the project Gantry runs in", async () => {
    const { api: fake } = fakeApi([db, web])
    await expect(runExternalOperation(fake, "nope", "stop")).rejects.toEqual(new ExternalProjectError("notFound"))
    const self = { ids: [web.Id], hostnames: [] }
    for (const op of ["stop", "restart", "redeploy", "remove"] as const) {
      await expect(runExternalOperation(fake, "shop", op, { self })).rejects.toEqual(new ExternalProjectError("selfContainer"))
    }
    await expect(runExternalOperation(fake, "shop", "start", { self })).resolves.toBeDefined()
  })
})

describe("composeProjectSchema", () => {
  it("accepts compose project names only", () => {
    for (const ok of ["shop", "my_app-2", "0x"]) expect(composeProjectSchema.safeParse(ok).success).toBe(true)
    for (const bad of ["", "-x", "Shop", "a b", "../x", "a/b"]) expect(composeProjectSchema.safeParse(bad).success).toBe(false)
  })
})
