import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { docker } from "@/lib/server/docker/api"
import { pullAndRecreate, recreateContainer, type RecreateInspect } from "@/lib/server/docker/recreate"

// Integration check against a real engine, on scratch resources only
// (gantry-test-* names, gantry.e2e=true label). Opt in with:
//   GANTRY_DOCKER_IT=1 pnpm test tests/unit/recreate.docker.test.ts
const enabled = process.env.GANTRY_DOCKER_IT === "1"
const api = docker({ type: "socket", url: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" })

const tag = Date.now().toString(36)
const NAME = `gantry-test-c-it-${tag}`
const BLOCKER = `gantry-test-c-it-${tag}-blocker`
const NET = `gantry-test-net-it-${tag}`
const VOL = `gantry-test-vol-it-${tag}`
const port = () => 20000 + Math.floor(Math.random() * 9000)
const PORT_A = port()
const PORT_B = PORT_A + 1
const PORT_TAKEN = PORT_A + 2

// Re-attached by name after a recreate, so `rm -v` no longer removes it.
let anonVolume = ""

const inspect = async (id: string) => (await api.inspectContainer(id)) as unknown as RecreateInspect

async function cleanup() {
  for (const c of await api.listContainers(true)) {
    if (c.Names.some((n) => n.startsWith(`/gantry-test-c-it-${tag}`)) && c.Labels["gantry.e2e"] === "true") {
      await api.removeContainer(c.Id, { force: true, volumes: true }).catch(() => {})
    }
  }
  for (const n of await api.listNetworks()) if (n.Name === NET) await api.removeNetwork(n.Id).catch(() => {})
  await api.removeVolume(VOL, true).catch(() => {})
  if (anonVolume) await api.removeVolume(anonVolume, true).catch(() => {})
}

describe.runIf(enabled)("recreate against Docker", () => {
  let id = ""

  beforeAll(async () => {
    await api.createNetwork(NET)
    await api.createVolume(VOL)
    const created = await api.createContainer(NAME, {
      Image: "alpine:3",
      Cmd: ["sleep", "900"],
      StopTimeout: 1,
      Env: ["FOO=one", "KEEP=yes"],
      Labels: { "gantry.e2e": "true", "com.example.keep": "1" },
      Volumes: { "/anon": {} },
      ExposedPorts: { "80/tcp": {} },
      Healthcheck: { Test: ["CMD", "true"], Interval: 60_000_000_000 },
      User: "nobody",
      HostConfig: {
        Binds: [`${VOL}:/data`],
        PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT_A) }] },
        RestartPolicy: { Name: "on-failure", MaximumRetryCount: 2 },
        CapDrop: ["MKNOD"],
      },
      NetworkingConfig: { EndpointsConfig: { [NET]: { Aliases: ["svc"] } } },
    })
    id = created.Id
    anonVolume = (await inspect(id)).Mounts!.find((m) => m.Destination === "/anon")!.Name!
    await api.containerAction(created.Id, "start")
  }, 180_000)

  afterAll(cleanup, 180_000)

  it("edits env + port, keeps everything else and reuses the anonymous volume", async () => {
    const res = await recreateContainer(api, {
      id,
      edits: {
        env: ["FOO=two", "KEEP=yes"],
        ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT_B) }] },
      },
    })
    expect(res.id).not.toBe(id)
    await expect(api.inspectContainer(id)).rejects.toThrow(/No such container/)

    const after = await inspect(res.id)
    expect(after.Name).toBe(`/${NAME}`)
    expect(after.State.Running).toBe(true)
    expect(after.Config.Env).toEqual(expect.arrayContaining(["FOO=two", "KEEP=yes"]))
    expect(after.HostConfig.PortBindings).toEqual({ "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT_B) }] })
    expect(after.Config.Labels).toMatchObject({ "gantry.e2e": "true", "com.example.keep": "1" })
    expect(after.Config).toMatchObject({ User: "nobody", Healthcheck: { Test: ["CMD", "true"] } })
    expect(after.HostConfig).toMatchObject({ RestartPolicy: { Name: "on-failure", MaximumRetryCount: 2 } })
    expect(after.HostConfig.CapDrop).toEqual(expect.arrayContaining([expect.stringMatching(/MKNOD/)]))
    expect(after.NetworkSettings.Networks![NET].Aliases).toEqual(["svc"])
    expect(after.Mounts!.find((m) => m.Destination === "/anon")?.Name).toBe(anonVolume)
    expect(after.Mounts!.find((m) => m.Destination === "/data")?.Name).toBe(VOL)
    expect(after.Config.Hostname).toBe(res.id.slice(0, 12))
    expect(after.Config.StopTimeout).toBe(1)
    const leftovers = (await api.listContainers(true)).filter((c) => c.Names.some((n) => n.includes("-gantry-old-")) && c.Names.some((n) => n.startsWith(`/${NAME}`)))
    expect(leftovers).toEqual([])
    id = res.id
  }, 300_000)

  it("rolls back when the new container can't start (port already taken)", async () => {
    const blocker = await api.createContainer(BLOCKER, {
      Image: "alpine:3",
      Cmd: ["sleep", "900"],
      StopTimeout: 1,
      Labels: { "gantry.e2e": "true" },
      ExposedPorts: { "80/tcp": {} },
      HostConfig: { PortBindings: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT_TAKEN) }] } },
    })
    await api.containerAction(blocker.Id, "start")

    await expect(
      recreateContainer(api, {
        id,
        edits: { ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT_TAKEN) }] } },
      })
    ).rejects.toThrow(/failed while starting the new container[\s\S]*Rolled back/)

    const restored = await inspect(id)
    expect(restored.Name).toBe(`/${NAME}`)
    expect(restored.State.Running).toBe(true)
    expect(restored.HostConfig.PortBindings).toEqual({ "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(PORT_B) }] })
    const mine = (await api.listContainers(true)).filter((c) => c.Names.some((n) => n.startsWith(`/${NAME}`)) && c.Id !== blocker.Id)
    expect(mine.map((c) => c.Id)).toEqual([id])
  }, 300_000)

  it("pull & recreate reports an unchanged image", async () => {
    const res = await pullAndRecreate(api, { id })
    expect(res).toEqual({ updated: false, image: "alpine:3" })
    expect((await inspect(id)).State.Running).toBe(true)
  }, 300_000)
})
