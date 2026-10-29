import { describe, expect, it } from "vitest"

import {
  formatArgs,
  formatPorts,
  parsePorts,
  parseVolumes,
  splitArgs,
  type EditFormValues,
} from "@/lib/container-form"
import {
  buildCreateSpec,
  editsFromForm,
  endpointConfig,
  formValuesFromInspect,
  isSelfContainer,
  parseSelfIds,
  pullAndRecreate,
  recreateBlocker,
  recreateContainer,
  RecreateError,
  type RecreateApi,
  type RecreateInspect,
} from "@/lib/server/docker/recreate"

import alpineImage from "./fixtures/image-alpine.json"
import composeFixture from "./fixtures/inspect-compose-static-ip.json"
import portsFixture from "./fixtures/inspect-ports-binds.json"

// Fixtures are real `docker inspect` output (Engine 29):
// - inspect-ports-binds: `docker create -e FOO=bar -e EMPTY= -p 18080:80
//   -p 127.0.0.1:18443:443/tcp -p 15353:53/udp -v gantry-test-vol-fix:/data
//   -v /tmp:/host-tmp:ro --mount type=tmpfs,destination=/scratch,tmpfs-size=1m
//   -v /anon --restart on-failure:3 --network gantry-test-net-fix
//   --network-alias web --network-alias api --health-cmd true --user 1000:1000
//   -w /work --cap-add NET_ADMIN --cap-drop MKNOD --ulimit nofile=1024:2048
//   --log-opt max-size=1m --memory 64m alpine:3 sleep 900`, then
//   `docker network connect bridge`, then started.
// - inspect-compose-static-ip: compose-labelled, custom hostname, custom
//   entrypoint, static IP + alias on a user network, HostConfig.Mounts with
//   options (volume nocopy, anonymous --mount volume, read-only bind).

const ports = () => structuredClone(portsFixture) as unknown as RecreateInspect
const compose = () => structuredClone(composeFixture) as unknown as RecreateInspect
const image = alpineImage.Config as Record<string, unknown>
const ANON = "66d49523514efecc64425983dcf1b6f103ab93124e216d4753123e0b15c7858c"
const CACHE_VOL = "e1c4614fb6a840d8f699549c74c7987a10bd0d59e37d5c13a38275fd590b2c28"

type Spec = Record<string, unknown> & {
  HostConfig: Record<string, unknown>
  NetworkingConfig?: { EndpointsConfig: Record<string, Record<string, unknown>> }
}
const specOf = (c: RecreateInspect, ...rest: Parameters<typeof buildCreateSpec> extends [unknown, ...infer R] ? R : never) => {
  const plan = buildCreateSpec(c, ...rest)
  return { ...plan, spec: plan.spec as Spec }
}

describe("buildCreateSpec: ports, binds, labels, healthcheck, default hostname", () => {
  const { name, spec, networks } = specOf(ports(), {}, image)

  it("keeps the name and the image reference (not the image id)", () => {
    expect(name).toBe("gantry-test-c-fixture")
    expect(spec.Image).toBe("alpine:3")
  })

  it("drops the default, id-based hostname", () => {
    expect(spec).not.toHaveProperty("Hostname")
    expect(spec.Domainname).toBe("")
  })

  it("keeps explicit env and drops the image's defaults", () => {
    expect(spec.Env).toEqual(["FOO=bar", "EMPTY="])
  })

  it("keeps command, user, working dir, healthcheck and labels", () => {
    expect(spec.Cmd).toEqual(["sleep", "900"])
    expect(spec).not.toHaveProperty("Entrypoint")
    expect(spec.User).toBe("1000:1000")
    expect(spec.WorkingDir).toBe("/work")
    expect(spec.Healthcheck).toEqual({ Test: ["CMD-SHELL", "true"], Interval: 30000000000 })
    expect(spec.Labels).toEqual({ "com.example.x": "y", "gantry.e2e": "true" })
  })

  it("keeps published ports exactly", () => {
    expect(spec.HostConfig.PortBindings).toEqual({
      "443/tcp": [{ HostIp: "127.0.0.1", HostPort: "18443" }],
      "53/udp": [{ HostIp: "", HostPort: "15353" }],
      "80/tcp": [{ HostIp: "", HostPort: "18080" }],
    })
    expect(Object.keys(spec.ExposedPorts as object).sort()).toEqual(["443/tcp", "53/udp", "80/tcp"])
  })

  it("keeps binds and named volumes, re-attaches the anonymous volume by name", () => {
    expect(spec.HostConfig.Binds).toEqual(["gantry-test-vol-fix:/data", "/tmp:/host-tmp:ro", `${ANON}:/anon`])
    expect(spec).not.toHaveProperty("Volumes")
  })

  it("keeps --mount entries with their options (tmpfs size)", () => {
    expect(spec.HostConfig.Mounts).toEqual([{ Type: "tmpfs", Target: "/scratch", TmpfsOptions: { SizeBytes: 1048576 } }])
  })

  it("keeps restart policy, capabilities, ulimits, log config and resources", () => {
    const hc = spec.HostConfig
    expect(hc.RestartPolicy).toEqual({ Name: "on-failure", MaximumRetryCount: 3 })
    expect(hc.CapAdd).toEqual(["CAP_NET_ADMIN"])
    expect(hc.CapDrop).toEqual(["CAP_MKNOD"])
    expect(hc.Ulimits).toEqual([{ Name: "nofile", Hard: 2048, Soft: 1024 }])
    expect(hc.LogConfig).toEqual({ Type: "json-file", Config: { "max-size": "1m" } })
    expect(hc.Memory).toBe(67108864)
    expect(hc).not.toHaveProperty("ContainerIDFile")
  })

  it("creates on the primary network with its aliases and connects the others afterwards", () => {
    expect(spec.HostConfig.NetworkMode).toBe("gantry-test-net-fix")
    expect(spec.NetworkingConfig).toEqual({ EndpointsConfig: { "gantry-test-net-fix": { Aliases: ["web", "api"] } } })
    expect(networks).toEqual([{ name: "bridge", endpoint: {} }])
  })

  it("never pins runtime network state (IP, MAC, endpoint ids)", () => {
    const text = JSON.stringify(spec)
    expect(text).not.toContain("MacAddress")
    expect(text).not.toContain("EndpointID")
    expect(text).not.toContain("172.25.0.2")
  })
})

describe("buildCreateSpec: compose labels, custom hostname, static IP, --mount options", () => {
  const { spec, networks } = specOf(compose(), {}, image)

  it("keeps a custom hostname and compose labels", () => {
    expect(spec.Hostname).toBe("api-host")
    expect(spec.Labels).toMatchObject({ "com.docker.compose.project": "demo", "com.docker.compose.service": "api" })
  })

  it("keeps a custom entrypoint and its arguments, drops the default working dir", () => {
    expect(spec.Entrypoint).toEqual(["sh"])
    expect(spec.Cmd).toEqual(["-c", "sleep 900"])
    expect(spec).not.toHaveProperty("WorkingDir")
    expect(spec.Env).toEqual(["A=1"])
  })

  it("keeps HostConfig.Mounts with options and pins the anonymous one", () => {
    expect(spec.HostConfig.Binds).toBeNull()
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: "gantry-test-vol-fix", Target: "/data", VolumeOptions: { NoCopy: true } },
      { Type: "volume", Source: CACHE_VOL, Target: "/cache" },
      { Type: "bind", Source: "/tmp", Target: "/mnt/tmp", ReadOnly: true },
    ])
  })

  it("keeps the static IP and alias", () => {
    expect(spec.HostConfig.NetworkMode).toBe("gantry-test-net-ip")
    expect(spec.NetworkingConfig?.EndpointsConfig).toEqual({
      "gantry-test-net-ip": { IPAMConfig: { IPv4Address: "10.251.77.10" }, Aliases: ["api"] },
    })
    expect(networks).toEqual([])
  })
})

describe("buildCreateSpec: image defaults", () => {
  it("keeps every value when the old image can't be inspected", () => {
    const { spec } = specOf(compose(), {}, null)
    expect(spec.Env).toEqual(["A=1", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"])
    expect(spec.WorkingDir).toBe("/")
  })

  it("lets an updated image supply its own defaults (env, cmd, labels, ports, healthcheck)", () => {
    const c = ports()
    c.Config.Env = ["APP_VERSION=1.0", "MODE=prod", "PATH=/bin"]
    c.Config.Cmd = ["server"]
    c.Config.Labels = { "org.opencontainers.image.version": "1.0", mine: "yes" }
    c.Config.ExposedPorts = { "80/tcp": {}, "9000/tcp": {} }
    c.HostConfig.PortBindings = { "80/tcp": [{ HostIp: "", HostPort: "8080" }] }
    const oldImage = {
      Env: ["APP_VERSION=1.0", "PATH=/bin"],
      Cmd: ["server"],
      Labels: { "org.opencontainers.image.version": "1.0" },
      ExposedPorts: { "80/tcp": {}, "9000/tcp": {} },
      Healthcheck: { Test: ["CMD-SHELL", "true"], Interval: 30000000000 },
      User: "1000:1000",
    }
    const { spec } = specOf(c, {}, oldImage)
    expect(spec.Env).toEqual(["MODE=prod"])
    expect(spec).not.toHaveProperty("Cmd")
    expect(spec.Labels).toEqual({ mine: "yes" })
    // Image-exposed ports are dropped, but published ones stay exposed.
    expect(spec.ExposedPorts).toEqual({ "80/tcp": {} })
    expect(spec).not.toHaveProperty("Healthcheck")
    expect(spec).not.toHaveProperty("User")
  })

  it("keeps CMD when the entrypoint was overridden, even if CMD matches the image", () => {
    const c = ports()
    c.Config.Entrypoint = ["/custom"]
    c.Config.Cmd = ["/bin/sh"]
    const { spec } = specOf(c, {}, image)
    expect(spec.Entrypoint).toEqual(["/custom"])
    expect(spec.Cmd).toEqual(["/bin/sh"])
  })

  it("an env override of an image variable is kept", () => {
    const c = ports()
    c.Config.Env = ["PATH=/opt/bin"]
    expect(specOf(c, {}, image).spec.Env).toEqual(["PATH=/opt/bin"])
  })
})

describe("buildCreateSpec: network modes and legacy fields", () => {
  it("host networking: no hostname, no endpoints", () => {
    const c = ports()
    c.HostConfig.NetworkMode = "host"
    c.Config.Hostname = "my-server"
    c.NetworkSettings.Networks = { host: { Aliases: null } }
    const { spec, networks } = specOf(c, {}, image)
    expect(spec).not.toHaveProperty("Hostname")
    expect(spec).not.toHaveProperty("NetworkingConfig")
    expect(spec.HostConfig.NetworkMode).toBe("host")
    expect(networks).toEqual([])
  })

  it("container:<id> networking: no hostname, no published or exposed ports", () => {
    const c = ports()
    c.HostConfig.NetworkMode = `container:${"a".repeat(64)}`
    c.NetworkSettings.Networks = {}
    const { spec } = specOf(c, {}, image)
    expect(spec).not.toHaveProperty("Hostname")
    expect(spec).not.toHaveProperty("ExposedPorts")
    expect(spec.HostConfig).not.toHaveProperty("PortBindings")
  })

  it("default network mode maps to the bridge endpoint", () => {
    const c = ports()
    c.HostConfig.NetworkMode = "default"
    c.NetworkSettings.Networks = { bridge: c.NetworkSettings.Networks!.bridge }
    const { spec, networks } = specOf(c, {}, image)
    expect(spec.HostConfig.NetworkMode).toBe("default")
    expect(spec.NetworkingConfig).toEqual({ EndpointsConfig: { bridge: {} } })
    expect(networks).toEqual([])
  })

  it("converts legacy links to create syntax", () => {
    const c = ports()
    c.HostConfig.Links = ["/db:/gantry-test-c-fixture/database", "/cache:/gantry-test-c-fixture/cache"]
    expect(specOf(c, {}, image).spec.HostConfig.Links).toEqual(["db:database", "cache:cache"])
  })

  it("drops the container-id alias older engines add, keeps the rest", () => {
    const id = ports().Id
    expect(
      endpointConfig(
        {
          Aliases: ["web", id.slice(0, 12)],
          IPAMConfig: { IPv4Address: "", IPv6Address: "fd00::5", LinkLocalIPs: [] },
          DriverOpts: { "com.example.opt": "1" },
          Links: ["db:db"],
          GwPriority: 10,
        },
        id
      )
    ).toEqual({
      Aliases: ["web"],
      IPAMConfig: { IPv6Address: "fd00::5" },
      DriverOpts: { "com.example.opt": "1" },
      Links: ["db:db"],
      GwPriority: 10,
    })
  })

  it("ignores volumes that come from --volumes-from", () => {
    const c = ports()
    c.HostConfig.VolumesFrom = ["other"]
    c.Mounts!.push({ Type: "volume", Name: "f".repeat(64), Source: "/x", Destination: "/shared", RW: true })
    const { spec } = specOf(c, {}, image)
    expect(spec.HostConfig.Binds).not.toContain(`${"f".repeat(64)}:/shared`)
    expect(spec.HostConfig.VolumesFrom).toEqual(["other"])
  })
})

describe("buildCreateSpec: edits", () => {
  it("applies env, command, image, name and restart edits", () => {
    const { name, spec } = specOf(
      ports(),
      { env: ["FOO=baz", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"], cmd: ["sleep", "1"], image: "alpine:3.20", name: "renamed", restart: "always" },
      image
    )
    expect(name).toBe("renamed")
    expect(spec.Image).toBe("alpine:3.20")
    // Unchanged image values in an edited list still defer to the image.
    expect(spec.Env).toEqual(["FOO=baz"])
    expect(spec.Cmd).toEqual(["sleep", "1"])
    expect(spec.HostConfig.RestartPolicy).toEqual({ Name: "always", MaximumRetryCount: 0 })
  })

  it("an empty command falls back to the image default", () => {
    expect(specOf(ports(), { cmd: null }, image).spec).not.toHaveProperty("Cmd")
  })

  it("replaces port bindings and un-exposes removed ones", () => {
    const { spec } = specOf(ports(), { ports: { "80/tcp": [{ HostIp: "", HostPort: "18081" }] } }, image)
    expect(spec.HostConfig.PortBindings).toEqual({ "80/tcp": [{ HostIp: "", HostPort: "18081" }] })
    expect(spec.ExposedPorts).toEqual({ "80/tcp": {} })
  })

  it("keeps unchanged mount lines verbatim (with options) and adds new binds", () => {
    const { spec } = specOf(
      compose(),
      { volumes: ["gantry-test-vol-fix:/data", "/tmp:/mnt/tmp:ro", "logs:/var/log"] },
      image
    )
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: "gantry-test-vol-fix", Target: "/data", VolumeOptions: { NoCopy: true } },
      { Type: "bind", Source: "/tmp", Target: "/mnt/tmp", ReadOnly: true },
    ])
    expect(spec.HostConfig.Binds).toEqual(["logs:/var/log"])
  })

  it("removing every editable mount keeps non-editable ones", () => {
    const { spec } = specOf(ports(), { volumes: [] }, image)
    expect(spec.HostConfig.Binds).toBeNull()
    expect(spec.HostConfig.Mounts).toEqual([{ Type: "tmpfs", Target: "/scratch", TmpfsOptions: { SizeBytes: 1048576 } }])
  })

  it("network edits: keep primary, add one, drop one", () => {
    const { spec, networks } = specOf(ports(), { networks: ["gantry-test-net-fix", "other"] }, image)
    expect(spec.HostConfig.NetworkMode).toBe("gantry-test-net-fix")
    expect(spec.NetworkingConfig?.EndpointsConfig).toEqual({ "gantry-test-net-fix": { Aliases: ["web", "api"] } })
    expect(networks).toEqual([{ name: "other", endpoint: {} }])
  })

  it("network edits: removing the primary network promotes the next one", () => {
    const { spec, networks } = specOf(compose(), { networks: ["bridge"] }, image)
    expect(spec.HostConfig.NetworkMode).toBe("bridge")
    expect(spec.NetworkingConfig?.EndpointsConfig).toEqual({ bridge: {} })
    expect(networks).toEqual([])
  })

  it("network edits: no networks at all means network mode none", () => {
    const { spec, networks } = specOf(ports(), { networks: [] }, image)
    expect(spec.HostConfig.NetworkMode).toBe("none")
    expect(spec).not.toHaveProperty("NetworkingConfig")
    expect(networks).toEqual([])
  })

  it("does not mutate the inspect object", () => {
    const c = ports()
    const before = JSON.stringify(c)
    buildCreateSpec(c, { env: [], ports: {}, volumes: [], networks: [] }, image)
    expect(JSON.stringify(c)).toBe(before)
  })
})

describe("edit form", () => {
  it("prefills from inspect", () => {
    expect(formValuesFromInspect(ports())).toEqual({
      image: "alpine:3",
      name: "gantry-test-c-fixture",
      command: "sleep 900",
      env: "FOO=bar\nEMPTY=\nPATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ports: "15353:53/udp\n18080:80\n127.0.0.1:18443:443",
      volumes: `gantry-test-vol-fix:/data\n/tmp:/host-tmp:ro\n${ANON}:/anon`,
      restart: "on-failure",
      networks: ["bridge", "gantry-test-net-fix"],
    } satisfies EditFormValues)
    expect(formValuesFromInspect(compose()).volumes).toBe(
      `gantry-test-vol-fix:/data\n${CACHE_VOL}:/cache\n/tmp:/mnt/tmp:ro`
    )
  })

  it("an untouched form (even with CRLF line endings) produces no edits", () => {
    const original = formValuesFromInspect(ports())
    const crlf = { ...original, env: original.env.replace(/\n/g, "\r\n") + "\r\n", ports: original.ports.replace(/\n/g, "\r\n") }
    expect(editsFromForm(original, crlf, [])).toEqual({ ok: true, edits: {} })
  })

  it("only reports changed fields", () => {
    const original = formValuesFromInspect(ports())
    const res = editsFromForm(
      original,
      { ...original, env: original.env.replace("FOO=bar", "FOO=changed"), ports: "18080:80\n19090:90/tcp", restart: "always" },
      []
    )
    expect(res).toEqual({
      ok: true,
      edits: {
        env: ["FOO=changed", "EMPTY=", "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
        ports: { "80/tcp": [{ HostIp: "", HostPort: "18080" }], "90/tcp": [{ HostIp: "", HostPort: "19090" }] },
        restart: "always",
      },
    })
  })

  it("an unchanged multi-line command is kept even though inputs strip newlines", () => {
    const c = ports()
    c.Config.Cmd = ["sh", "-c", "echo a\necho b"]
    const original = formValuesFromInspect(c)
    expect(editsFromForm(original, { ...original, command: original.command.replace(/\n/g, "") }, [])).toEqual({
      ok: true,
      edits: {},
    })
  })

  it("validates edited fields like the create form", () => {
    const original = formValuesFromInspect(ports())
    expect(editsFromForm(original, { ...original, env: "not valid" }, [])).toMatchObject({
      ok: false,
      fieldErrors: { env: [expect.stringContaining("KEY=value")] },
    })
    expect(editsFromForm(original, { ...original, ports: "abc" }, [])).toMatchObject({
      ok: false,
      fieldErrors: { ports: [expect.any(String)] },
    })
    expect(editsFromForm(original, { ...original, volumes: "a:/x\nb:/x" }, [])).toMatchObject({
      ok: false,
      fieldErrors: { volumes: [expect.stringContaining("more than once")] },
    })
    expect(editsFromForm(original, { ...original, networks: ["bridge", "nope"] }, ["bridge"])).toMatchObject({
      ok: false,
      fieldErrors: { networks: [expect.stringContaining("nope")] },
    })
  })

  it("network changes are detected regardless of order", () => {
    const original = formValuesFromInspect(ports())
    expect(editsFromForm(original, { ...original, networks: ["gantry-test-net-fix", "bridge"] }, [])).toEqual({
      ok: true,
      edits: {},
    })
    expect(editsFromForm(original, { ...original, networks: ["gantry-test-net-fix"] }, [])).toEqual({
      ok: true,
      edits: { networks: ["gantry-test-net-fix"] },
    })
  })
})

describe("form parsing helpers", () => {
  it("port lines round-trip, including IPv6 and random host ports", () => {
    const bindings = {
      "80/tcp": [
        { HostIp: "", HostPort: "8080" },
        { HostIp: "::1", HostPort: "8080" },
      ],
      "53/udp": [{ HostIp: "127.0.0.1", HostPort: "5353" }],
      "9000/tcp": [{ HostIp: "", HostPort: "" }],
      "9001/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }],
    }
    const text = formatPorts(bindings)
    expect(text).toBe("127.0.0.1:5353:53/udp\n8080:80\n[::1]:8080:80\n9000\n0.0.0.0::9001")
    const parsed = parsePorts(text)
    expect(parsed.ok && parsed.value.bindings).toEqual(bindings)
  })

  it("rejects bad ports", () => {
    expect(parsePorts("70000:80").ok).toBe(false)
    expect(parsePorts("80:0").ok).toBe(false)
    expect(parsePorts("8080:80/icmp").ok).toBe(false)
  })

  it("command arguments round-trip", () => {
    const args = ["sh", "-c", "echo 'hi there'", 'say "x"', ""]
    expect(splitArgs(formatArgs(args))).toEqual(args)
  })

  it("accepts mount options Docker understands", () => {
    expect(parseVolumes("data:/data:ro,z\n/srv:/srv:rslave").ok).toBe(true)
    expect(parseVolumes("data:/data:bogus").ok).toBe(false)
    expect(parseVolumes("relative/path").ok).toBe(false)
  })
})

describe("Gantry's own container", () => {
  const id = "3f1c9a2b4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8"

  it("finds the id in cgroup v1 and v2 (host cgroupns) paths", () => {
    expect(parseSelfIds({ cgroup: `12:memory:/docker/${id}\n0::/` }).ids).toEqual([id])
    expect(parseSelfIds({ cgroup: `0::/system.slice/docker-${id}.scope` }).ids).toEqual([id])
    expect(parseSelfIds({ cgroup: "0::/" }).ids).toEqual([])
  })

  it("finds the id in the /etc/hostname bind mount", () => {
    const mountinfo = [
      "613 590 0:52 / / rw,relatime master:1 - overlay overlay rw",
      `640 613 8:1 /var/lib/docker/containers/${id}/hostname /etc/hostname rw,relatime - ext4 /dev/sda1 rw`,
    ].join("\n")
    expect(parseSelfIds({ mountinfo }).ids).toEqual([id])
  })

  it("ignores per-container shm mounts visible on the host", () => {
    const mountinfo = `700 29 0:60 / /var/lib/docker/containers/${id}/mounts/shm rw - tmpfs shm rw`
    expect(parseSelfIds({ mountinfo }).ids).toEqual([])
  })

  it("matches the id-prefix hostname but not ordinary hostnames or HOSTNAME=0.0.0.0", () => {
    const self = parseSelfIds({ hostnames: [id.slice(0, 12), "0.0.0.0", "my-laptop"] })
    expect(self.hostnames).toEqual([id.slice(0, 12)])
    expect(isSelfContainer({ Id: id }, self)).toBe(true)
    expect(isSelfContainer({ Id: "b".repeat(64) }, self)).toBe(false)
  })

  it("blocks recreating itself, auto-remove and paused containers", () => {
    const c = ports()
    expect(recreateBlocker(c, { ids: [c.Id], hostnames: [] })).toMatch(/Gantry's own container/)
    expect(recreateBlocker(c, { ids: [], hostnames: [] })).toBeNull()
    expect(recreateBlocker({ ...c, HostConfig: { ...c.HostConfig, AutoRemove: true } })).toMatch(/--rm/)
    expect(recreateBlocker({ ...c, State: { ...c.State, Paused: true } })).toMatch(/Resume/)
  })
})

// ---------------------------------------------------------------------------
// Swap & rollback against an in-memory Docker

type Step = "pull" | "stop" | "rename" | "create" | "create-timeout" | "connect" | "start-new" | "remove-old" | "rollback-remove" | "rollback-rename" | "rollback-start"

class FakeDocker implements RecreateApi {
  containers = new Map<string, { name: string; running: boolean; spec?: Record<string, unknown>; networks: string[] }>()
  calls: string[] = []
  images: Record<string, string> = { "alpine:3": "sha256:old" }
  private renames = 0
  private seq = 0

  constructor(
    private inspect: RecreateInspect,
    private failAt: Step[] = []
  ) {
    this.containers.set(inspect.Id, { name: inspect.Name.slice(1), running: inspect.State.Running, networks: [] })
  }

  private maybeFail(step: Step) {
    if (this.failAt.includes(step)) throw new Error(`${step} exploded`)
  }

  private find(idOrName: string) {
    const byId = this.containers.get(idOrName)
    if (byId) return [idOrName, byId] as const
    const byName = [...this.containers.entries()].find(([, c]) => c.name === idOrName)
    if (!byName) throw new Error(`No such container: ${idOrName}`)
    return byName
  }

  private get(idOrName: string) {
    return this.find(idOrName)[1]
  }

  async inspectContainer(idOrName: string) {
    this.calls.push(`inspect ${idOrName.slice(0, 4)}`)
    const [id, c] = this.find(idOrName)
    return { ...this.inspect, Id: id, Name: `/${c.name}`, State: { ...this.inspect.State, Running: c.running } }
  }
  async inspectImage(ref: string) {
    this.calls.push(`inspectImage ${ref}`)
    const id = ref.startsWith("sha256:") ? ref : this.images[ref]
    if (!id) throw new Error(`No such image: ${ref}`)
    return { Id: id, Config: image }
  }
  async pullImage(ref: string) {
    this.calls.push(`pull ${ref}`)
    this.maybeFail("pull")
  }
  async containerAction(id: string, action: "start" | "stop") {
    const isOld = id === this.inspect.Id
    this.calls.push(`${action} ${isOld ? "old" : "new"}`)
    if (action === "stop") this.maybeFail("stop")
    if (action === "start") this.maybeFail(isOld ? "rollback-start" : "start-new")
    this.get(id).running = action === "start"
  }
  async renameContainer(id: string, name: string) {
    this.calls.push(`rename ${name}`)
    // The first rename parks the old container; any later one is the rollback.
    this.maybeFail(this.renames++ === 0 ? "rename" : "rollback-rename")
    if ([...this.containers.values()].some((c) => c.name === name)) throw new Error("Conflict: name in use")
    this.get(id).name = name
  }
  async createContainer(name: string | undefined, spec: Record<string, unknown>) {
    this.calls.push(`create ${name}`)
    this.maybeFail("create")
    if ([...this.containers.values()].some((c) => c.name === name)) throw new Error(`Conflict. The container name "/${name}" is already in use`)
    const id = `new${++this.seq}`.padEnd(64, "0")
    this.containers.set(id, { name: name!, running: false, spec, networks: [] })
    // The engine did the work, but the client gave up waiting.
    if (this.failAt.includes("create-timeout")) throw new Error("Docker API request timed out")
    return { Id: id, Warnings: [] }
  }
  async connectNetwork(network: string, container: string) {
    this.calls.push(`connect ${network}`)
    this.maybeFail("connect")
    this.get(container).networks.push(network)
  }
  async removeContainer(id: string) {
    const isOld = id === this.inspect.Id
    this.calls.push(`remove ${isOld ? "old" : "new"}`)
    this.maybeFail(isOld ? "remove-old" : "rollback-remove")
    this.containers.delete(id)
  }

  get state() {
    return [...this.containers.entries()].map(([id, c]) => ({
      who: id === this.inspect.Id ? "old" : "new",
      name: c.name,
      running: c.running,
    }))
  }
}

const NOW = () => 1700000000000
const PARKED = `gantry-test-c-fixture-gantry-old-${NOW()}`

async function run(failAt: Step[] = [], opts: { running?: boolean; pull?: boolean; edits?: Parameters<typeof recreateContainer>[1]["edits"] } = {}) {
  const c = ports()
  c.State.Running = opts.running ?? true
  const fake = new FakeDocker(c, failAt)
  let error: unknown
  let result: Awaited<ReturnType<typeof recreateContainer>> | undefined
  try {
    result = await recreateContainer(fake, {
      id: c.Id,
      now: NOW,
      pull: opts.pull,
      edits: opts.edits,
      sleep: async () => {},
    })
  } catch (err) {
    error = err
  }
  return { fake, error, result }
}

describe("recreateContainer: safe swap", () => {
  it("success: stop → rename → create → connect → start → remove old", async () => {
    const { fake, error, result } = await run()
    expect(error).toBeUndefined()
    expect(fake.calls).toEqual([
      `inspect ${ports().Id.slice(0, 4)}`,
      "inspectImage sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a",
      "stop old",
      `rename ${PARKED}`,
      "create gantry-test-c-fixture",
      "connect bridge",
      "start new",
      "remove old",
    ])
    expect(fake.state).toEqual([{ who: "new", name: "gantry-test-c-fixture", running: true }])
    expect(result).toMatchObject({ name: "gantry-test-c-fixture", previousId: ports().Id, warnings: [] })
  })

  it("a stopped container is replaced but not started", async () => {
    const { fake, error } = await run([], { running: false })
    expect(error).toBeUndefined()
    expect(fake.calls).not.toContain("stop old")
    expect(fake.calls).not.toContain("start new")
    expect(fake.state).toEqual([{ who: "new", name: "gantry-test-c-fixture", running: false }])
  })

  it("pulls before touching the container; a failed pull changes nothing", async () => {
    const { fake, error } = await run(["pull"], { pull: true })
    expect(String(error)).toMatch(/pull exploded/)
    expect(fake.calls.at(-1)).toBe("pull alpine:3")
    expect(fake.state).toEqual([{ who: "old", name: "gantry-test-c-fixture", running: true }])
  })

  it("refuses a new image that isn't available locally before stopping anything", async () => {
    const { fake, error } = await run([], { edits: { image: "alpine:missing" } })
    expect(error).toBeInstanceOf(RecreateError)
    expect(String(error)).toMatch(/not available locally/)
    expect(fake.calls).not.toContain("stop old")
    expect(fake.state).toEqual([{ who: "old", name: "gantry-test-c-fixture", running: true }])
  })

  it("stop fails: nothing renamed, old container still running", async () => {
    const { fake, error } = await run(["stop"])
    expect(String(error)).toMatch(/Could not stop .*Nothing was changed/)
    expect(fake.calls).not.toContain(`rename ${PARKED}`)
    expect(fake.state).toEqual([{ who: "old", name: "gantry-test-c-fixture", running: true }])
  })

  it("rename fails: old container started again under its name", async () => {
    const { fake, error } = await run(["rename"])
    expect(String(error)).toMatch(/Could not rename/)
    expect(fake.calls.slice(-2)).toEqual([`rename ${PARKED}`, "start old"])
    expect(fake.state).toEqual([{ who: "old", name: "gantry-test-c-fixture", running: true }])
  })

  for (const [step, label] of [
    ["create", "creating the new container"],
    ["connect", 'connecting it to network "bridge"'],
    ["start-new", "starting the new container"],
  ] as const) {
    it(`${step} fails: new container removed, old one renamed back and restarted`, async () => {
      const { fake, error } = await run([step])
      expect(error).toBeInstanceOf(RecreateError)
      expect(String(error)).toContain(`failed while ${label}`)
      expect(String(error)).toContain("Rolled back: gantry-test-c-fixture is running")
      expect(fake.state).toEqual([{ who: "old", name: "gantry-test-c-fixture", running: true }])
      expect(fake.calls.at(-1)).toBe("start old")
      if (step !== "create") expect(fake.calls).toContain("remove new")
    })
  }

  it("create times out but the engine created it anyway: the stray container is found by name and removed", async () => {
    const { fake, error } = await run(["create-timeout"])
    expect(String(error)).toContain("Rolled back: gantry-test-c-fixture is running")
    expect(fake.calls).toContain("inspect gant")
    expect(fake.calls).toContain("remove new")
    expect(fake.state).toEqual([{ who: "old", name: "gantry-test-c-fixture", running: true }])
  })

  it("a rename to a name that is taken is refused before anything changes", async () => {
    const c = ports()
    const fake = new FakeDocker(c)
    fake.containers.set("e".repeat(64), { name: "taken", running: true, networks: [] })
    await expect(recreateContainer(fake, { id: c.Id, edits: { name: "taken" } })).rejects.toThrow(/named "taken" already exists/)
    expect(fake.calls).not.toContain("stop old")
    // Other containers are never touched, even when a create fails with a conflict.
    expect(fake.state).toContainEqual({ who: "new", name: "taken", running: true })
  })

  it("a stopped container is restored without being started", async () => {
    const { fake, error } = await run(["create"], { running: false })
    expect(String(error)).toContain("Rolled back: gantry-test-c-fixture is back")
    expect(fake.calls).not.toContain("start old")
    expect(fake.state).toEqual([{ who: "old", name: "gantry-test-c-fixture", running: false }])
  })

  it("rollback can't rename back: old container kept (and running) under the parked name", async () => {
    const { fake, error } = await run(["start-new", "rollback-rename"])
    expect(String(error)).toMatch(/Rollback incomplete: the original container could not be renamed back and is kept as/)
    expect(String(error)).toContain(PARKED)
    expect(fake.state).toEqual([{ who: "old", name: PARKED, running: true }])
  })

  it("rollback can't remove the new container: reported, old container still restored", async () => {
    const { fake, error } = await run(["start-new", "rollback-remove"])
    expect(String(error)).toMatch(/Rollback incomplete: the new container new1\S* could not be removed/)
    // The new container still holds the name, so the old one keeps the parked name — but runs.
    expect(fake.state).toEqual([
      { who: "old", name: PARKED, running: true },
      { who: "new", name: "gantry-test-c-fixture", running: false },
    ])
  })

  it("rollback can't start the old container: reported", async () => {
    const { fake, error } = await run(["create", "rollback-start"])
    expect(String(error)).toMatch(/could not be started again/)
    expect(fake.state).toEqual([{ who: "old", name: "gantry-test-c-fixture", running: false }])
  })

  it("old container can't be removed: success with a warning, never a rollback", async () => {
    const { fake, error, result } = await run(["remove-old"])
    expect(error).toBeUndefined()
    expect(result?.warnings.join(" ")).toContain(`kept as "${PARKED}"`)
    expect(fake.state).toEqual([
      { who: "old", name: PARKED, running: false },
      { who: "new", name: "gantry-test-c-fixture", running: true },
    ])
  })

  it("refuses Gantry's own container before doing anything", async () => {
    const c = ports()
    const fake = new FakeDocker(c)
    await expect(recreateContainer(fake, { id: c.Id, self: { ids: [c.Id], hostnames: [] } })).rejects.toThrow(
      /Gantry's own container/
    )
    expect(fake.calls).toHaveLength(1)
  })
})

describe("pullAndRecreate", () => {
  it("does nothing when the pulled image is the one already in use", async () => {
    const c = ports()
    const fake = new FakeDocker(c)
    fake.images["alpine:3"] = c.Image
    const res = await pullAndRecreate(fake, { id: c.Id, now: NOW })
    expect(res).toEqual({ updated: false, image: "alpine:3" })
    expect(fake.calls).not.toContain("stop old")
  })

  it("recreates with identical settings when the image changed", async () => {
    const c = ports()
    const fake = new FakeDocker(c)
    fake.images["alpine:3"] = "sha256:newer"
    const res = await pullAndRecreate(fake, { id: c.Id, now: NOW })
    expect(res.updated).toBe(true)
    expect(fake.calls.slice(0, 3)).toEqual([`inspect ${c.Id.slice(0, 4)}`, "pull alpine:3", "inspectImage alpine:3"])
    const created = [...fake.containers.values()][0]
    expect(created.spec).toEqual(buildCreateSpec(c, {}, image).spec)
  })

  it("refuses containers created from an image id", async () => {
    const c = ports()
    c.Config.Image = c.Image
    await expect(pullAndRecreate(new FakeDocker(c), { id: c.Id })).rejects.toThrow(/image ID/)
  })
})
