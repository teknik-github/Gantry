import { describe, expect, it } from "vitest"

import { checkableReference, containerUpdateStatus, hasDigest, shortReference } from "@/lib/image-updates"

describe("checkableReference", () => {
  it.each([
    ["nginx", "nginx:latest"],
    ["nginx:1.27", "nginx:1.27"],
    ["ghcr.io/org/app", "ghcr.io/org/app:latest"],
    ["registry.example.com:5000/app", "registry.example.com:5000/app:latest"],
    ["registry.example.com:5000/app:2", "registry.example.com:5000/app:2"],
  ])("%s → %s", (ref, out) => expect(checkableReference(ref)).toBe(out))

  it.each(["", "sha256:" + "a".repeat(64), "a".repeat(12), "nginx@sha256:" + "b".repeat(64)])(
    "ignores %j (id or pinned digest)",
    (ref) => expect(checkableReference(ref)).toBeNull()
  )
})

describe("containerUpdateStatus", () => {
  const remote = (digest: string | null, error: string | null = null) => ({ digest, error })
  const img = (Id: string, RepoDigests: string[] = [], RepoTags: string[] = []) => ({ Id, RepoDigests, RepoTags })

  it("matches on the digest whatever the repository name", () => {
    expect(hasDigest(["docker.io/library/nginx@sha256:aaa", "nginx@sha256:bbb"], "sha256:bbb")).toBe(true)
    expect(hasDigest(null, "sha256:bbb")).toBe(false)
  })

  it("classic image store: compares RepoDigests", () => {
    const running = img("sha256:cfg1", ["nginx@sha256:aaa"])
    expect(containerUpdateStatus("sha256:cfg1", { tagged: running, running }, remote("sha256:aaa"))).toEqual({ status: "current" })
    expect(containerUpdateStatus("sha256:cfg1", { tagged: running, running }, remote("sha256:new"))).toEqual({ status: "update" })
  })

  it("containerd image store: the image id is the digest", () => {
    const running = img("sha256:aaa")
    expect(containerUpdateStatus("sha256:aaa", { tagged: running, running }, remote("sha256:aaa"))).toEqual({ status: "current" })
  })

  it("a tag that moved to another local image means the container is behind", () => {
    // containerd keeps no RepoDigests for the untagged old image.
    expect(
      containerUpdateStatus("sha256:old", { tagged: img("sha256:new", ["app@sha256:new"]), running: img("sha256:old") }, remote("sha256:new"))
    ).toMatchObject({ status: "update" })
  })

  it("unknown for registry errors and locally built images", () => {
    expect(containerUpdateStatus("sha256:x", { tagged: null, running: img("sha256:x") }, remote(null, "unauthorized"))).toEqual({
      status: "unknown",
      reason: "unauthorized",
    })
    expect(containerUpdateStatus("sha256:x", { tagged: img("sha256:x"), running: null }, remote("sha256:aaa"))).toMatchObject({
      status: "unknown",
      reason: expect.stringMatching(/locally/),
    })
  })
})

describe("shortReference", () => {
  it("drops docker.io/ and library/", () => {
    expect(shortReference("docker.io/library/nginx:1")).toBe("nginx:1")
    expect(shortReference("docker.io/org/app:2")).toBe("org/app:2")
    expect(shortReference("ghcr.io/org/app:2")).toBe("ghcr.io/org/app:2")
  })
})

describe("containerReferences", () => {
  it("inspects only containers listed by image id (their tag moved on)", async () => {
    const { containerReferences, referencesOf } = await import("@/lib/server/image-updates")
    const inspected: string[] = []
    const api = {
      inspectContainer: async (id: string) => {
        inspected.push(id)
        return { Config: { Image: "ghcr.io/org/app:1" } } as Awaited<ReturnType<import("@/lib/server/docker/api").DockerApi["inspectContainer"]>>
      },
    }
    const refs = await containerReferences(api, [
      { Id: "a", Image: "nginx:1.27" },
      { Id: "b", Image: "sha256:" + "c".repeat(64) },
      { Id: "c", Image: "nginx" },
    ])
    expect(inspected).toEqual(["b"])
    expect(refs).toEqual(new Map([["a", "nginx:1.27"], ["b", "ghcr.io/org/app:1"], ["c", "nginx"]]))
    expect(referencesOf(refs)).toEqual(["ghcr.io/org/app:1", "nginx:1.27", "nginx:latest"])
  })
})

describe("localImagesFor", () => {
  it("inspects only images of containers whose tag was checked, by id and by tag", async () => {
    const { checkReferences, localImagesFor, containerUpdates } = await import("@/lib/server/image-updates")
    type Api = Parameters<typeof checkReferences>[1]
    const api = {
      distributionInspect: async () => ({ Descriptor: { digest: "sha256:new" } }),
      inspectImage: async (ref: string) => {
        inspected.push(ref)
        return ref === "app:1"
          ? { Id: "sha256:new", RepoTags: ["app:1"], RepoDigests: ["app@sha256:new"], Config: null }
          : { Id: ref, RepoTags: [], RepoDigests: [], Config: null }
      },
    }
    const inspected: string[] = []
    await checkReferences(4242, api as unknown as Api, ["app:1"])
    const containers = [
      { Id: "a", Image: "app:1", ImageID: "sha256:old" },
      { Id: "b", Image: "other:2", ImageID: "sha256:x" },
    ]
    const refs = new Map([["a", "app:1"], ["b", "other:2"]])
    const local = await localImagesFor(api, 4242, containers, refs)
    expect(inspected.sort()).toEqual(["app:1", "sha256:old"])
    expect(containerUpdates(4242, containers, local, refs).get("a")).toMatchObject({ status: "update", remoteDigest: "sha256:new" })
    expect(containerUpdates(4242, containers, local, refs).has("b")).toBe(false)
  })
})

describe("updateCheckIntervalMs", () => {
  it("treats an empty value as the default, 0 as on demand only", async () => {
    const { updateCheckIntervalMs } = await import("@/lib/server/image-updates")
    const previous = process.env.UPDATE_CHECK_INTERVAL_HOURS
    try {
      process.env.UPDATE_CHECK_INTERVAL_HOURS = ""
      expect(updateCheckIntervalMs()).toBe(6 * 3_600_000)
      delete process.env.UPDATE_CHECK_INTERVAL_HOURS
      expect(updateCheckIntervalMs()).toBe(6 * 3_600_000)
      process.env.UPDATE_CHECK_INTERVAL_HOURS = "0"
      expect(updateCheckIntervalMs()).toBe(0)
      process.env.UPDATE_CHECK_INTERVAL_HOURS = "2"
      expect(updateCheckIntervalMs()).toBe(2 * 3_600_000)
    } finally {
      if (previous === undefined) delete process.env.UPDATE_CHECK_INTERVAL_HOURS
      else process.env.UPDATE_CHECK_INTERVAL_HOURS = previous
    }
  })
})
