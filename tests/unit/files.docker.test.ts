import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { docker } from "@/lib/server/docker/api"
import { dockerJson } from "@/lib/server/docker/client"
import { HELPER_LABEL } from "@/lib/server/files/helper"
import {
  createFolder,
  deletePath,
  listFiles,
  openDownload,
  readTextFile,
  uploadFile,
  type FileTarget,
} from "@/lib/server/files/service"

// File browser against a real engine, on scratch resources only
// (gantry-test-f-* names). Opt in with:
//   GANTRY_DOCKER_IT=1 pnpm test tests/unit/files.docker.test.ts
const enabled = process.env.GANTRY_DOCKER_IT === "1"
const api = docker({ type: "socket", url: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock" })

const tag = Date.now().toString(36)
const RUNNING = `gantry-test-f-it-${tag}-run`
const STOPPED = `gantry-test-f-it-${tag}-stop`
const VOL = `gantry-test-f-it-${tag}-vol`

async function* bytes(data: string | Buffer) {
  yield typeof data === "string" ? Buffer.from(data) : data
}

async function collect(body: AsyncIterable<Buffer>) {
  const chunks: Buffer[] = []
  for await (const c of body) chunks.push(c)
  return Buffer.concat(chunks)
}

async function run(name: string, cmd: string[], opts: { start: boolean; volume?: string }) {
  try {
    await api.inspectImage("alpine:3")
  } catch {
    await api.pullImage("alpine:3")
  }
  const { Id } = await api.createContainer(name, {
    Image: "alpine:3",
    Cmd: cmd,
    Labels: { "gantry.e2e": "true" },
    HostConfig: opts.volume ? { Binds: [`${opts.volume}:/data`] } : {},
  })
  if (opts.start) await api.containerAction(Id, "start")
  return Id
}

async function helpers() {
  return dockerJson<{ Id: string; Labels: Record<string, string> }[]>(api.target, "GET", "/containers/json", {
    query: { all: true, filters: JSON.stringify({ label: [`${HELPER_LABEL}=files`, `gantry.helper.volume=${VOL}`] }) },
  })
}

async function cleanup() {
  for (const name of [RUNNING, STOPPED, `${VOL}-writer`]) await api.removeContainer(name, { force: true, volumes: true }).catch(() => {})
  for (const h of await helpers().catch(() => [])) await api.removeContainer(h.Id, { force: true }).catch(() => {})
  await api.removeVolume(VOL, true).catch(() => {})
}

// Slow on a loaded host: creating a container can take minutes there.
const SLOW = 900_000

describe.runIf(enabled)("file browser against Docker", () => {
  let running: FileTarget
  let stopped: FileTarget
  const volume: FileTarget = { kind: "volume", name: VOL }

  beforeAll(async () => {
    // Pooled helpers go away soon after the last operation.
    process.env.FILES_HELPER_IDLE_SECONDS = "5"
    await cleanup()
    running = { kind: "container", id: await run(RUNNING, ["sleep", "600"], { start: true }) }
    const stoppedId = await run(STOPPED, ["sh", "-c", "mkdir -p /srv/a && echo hi > /srv/a/x.txt && ln -s a /srv/link"], { start: true })
    await dockerJson(api.target, "POST", `/containers/${stoppedId}/wait`, { timeoutMs: 60_000 })
    stopped = { kind: "container", id: stoppedId }
    await api.createVolume(VOL)
    const writer = await run(`${VOL}-writer`, ["sh", "-c", "echo hello > /data/hello.txt && mkdir /data/sub && ln -s /etc /data/evil"], {
      start: true,
      volume: VOL,
    })
    await dockerJson(api.target, "POST", `/containers/${writer}/wait`, { timeoutMs: 60_000 })
  }, SLOW)

  afterAll(cleanup, SLOW)

  it("lists a running container's folder through exec", async () => {
    const t0 = Date.now()
    const listing = await listFiles(api, running, "/etc")
    console.log(`exec listing of /etc: ${Date.now() - t0} ms, ${listing.entries.length} entries`)
    expect(listing.source).toBe("exec")
    const passwd = listing.entries.find((e) => e.name === "passwd")
    expect(passwd).toMatchObject({ type: "file", uid: 0, user: "root" })
    expect(listing.entries.find((e) => e.name === "apk")?.type).toBe("dir")
    const bin = await listFiles(api, running, "/bin")
    expect(bin.entries.find((e) => e.name === "sh")).toMatchObject({ type: "symlink", linkTarget: "/bin/busybox" })
  }, SLOW)

  it("lists a stopped container from the archive and follows a linked folder", async () => {
    const listing = await listFiles(api, stopped, "/srv")
    expect(listing.source).toBe("archive")
    expect(listing.entries.map((e) => [e.name, e.type])).toEqual([
      ["a", "dir"],
      ["link", "symlink"],
    ])
    const viaLink = await listFiles(api, stopped, "/srv/link")
    expect(viaLink.entries.map((e) => e.name)).toEqual(["x.txt"])
    await expect(listFiles(api, stopped, "/nope")).rejects.toThrow(/doesn't exist/)
    await expect(listFiles(api, stopped, "/srv/a/x.txt")).rejects.toThrow(/not a folder/)
  }, SLOW)

  it("uploads, reads, overwrites (keeping owner and mode) and downloads a file", async () => {
    await uploadFile(api, running, { dir: "/tmp", name: "note.txt", size: 6, body: bytes("first\n"), overwrite: false })
    await expect(
      uploadFile(api, running, { dir: "/tmp", name: "note.txt", size: 3, body: bytes("x\n\n"), overwrite: false })
    ).rejects.toMatchObject({ code: "exists", status: 409 })
    await api.execRun(running.kind === "container" ? running.id : "", ["sh", "-c", "chown 123:456 /tmp/note.txt && chmod 600 /tmp/note.txt"])
    await uploadFile(api, running, { dir: "/tmp", name: "note.txt", size: 7, body: bytes("second\n"), overwrite: true })
    const text = await readTextFile(api, running, "/tmp/note.txt")
    expect(text).toMatchObject({ ok: true, content: "second\n", mode: 0o600 })
    const entry = (await listFiles(api, running, "/tmp")).entries.find((e) => e.name === "note.txt")
    expect(entry).toMatchObject({ uid: 123, gid: 456, mode: 0o600, size: 7 })

    const download = await openDownload(api, running, "/tmp/note.txt")
    expect(download).toMatchObject({ kind: "file", size: 7, filename: "note.txt" })
    expect((await collect(download.body)).toString()).toBe("second\n")

    // A size mismatch never completes the archive.
    await expect(
      uploadFile(api, running, { dir: "/tmp", name: "short.bin", size: 100, body: bytes("abc"), overwrite: false })
    ).rejects.toThrow()
  }, SLOW)

  it("detects binary files and large ones for the editor", async () => {
    await uploadFile(api, running, { dir: "/tmp", name: "bin.dat", size: 4, body: bytes(Buffer.from([1, 0, 2, 3])), overwrite: false })
    expect(await readTextFile(api, running, "/tmp/bin.dat")).toMatchObject({ ok: false, reason: "binary" })
    expect(await readTextFile(api, running, "/bin/busybox")).toMatchObject({ ok: false })
  }, SLOW)

  it("downloads a folder as tar, writes into a stopped container, creates and deletes folders", async () => {
    const tar = await openDownload(api, running, "/etc/apk")
    expect(tar).toMatchObject({ kind: "tar", filename: "apk.tar" })
    const data = await collect(tar.body)
    expect(data.subarray(0, 4).toString()).toBe("apk/")

    await uploadFile(api, stopped, { dir: "/srv", name: "new.txt", size: 3, body: bytes("ok\n"), overwrite: false })
    await createFolder(api, stopped, "/srv", "made")
    expect((await listFiles(api, stopped, "/srv")).entries.map((e) => e.name)).toEqual(["a", "made", "link", "new.txt"])
    await expect(deletePath(api, stopped, "/srv/made")).rejects.toThrow(/running container/)

    await createFolder(api, running, "/tmp", "dir one")
    await expect(createFolder(api, running, "/tmp", "dir one")).rejects.toThrow(/already exists/)
    await deletePath(api, running, "/tmp/dir one")
    expect((await listFiles(api, running, "/tmp")).entries.some((e) => e.name === "dir one")).toBe(false)
  }, SLOW)

  it("browses and writes a volume through helpers that are always removed", async () => {
    const t0 = Date.now()
    const listing = await listFiles(api, volume, "/")
    console.log(`volume listing through a helper: ${Date.now() - t0} ms`)
    expect(listing.entries.map((e) => [e.name, e.type])).toEqual([
      ["sub", "dir"],
      ["evil", "symlink"],
      ["hello.txt", "file"],
    ])
    expect(await readTextFile(api, volume, "/hello.txt")).toMatchObject({ ok: true, content: "hello\n" })

    await uploadFile(api, volume, { dir: "/sub", name: "up.txt", size: 9, body: bytes("uploaded\n"), overwrite: false })
    const download = await openDownload(api, volume, "/sub/up.txt")
    expect((await collect(download.body)).toString()).toBe("uploaded\n")
    await download.cleanup?.()
    await createFolder(api, volume, "/", "folder")
    await deletePath(api, volume, "/folder")

    // Links inside the volume are never followed.
    await expect(listFiles(api, volume, "/evil")).rejects.toThrow(/symbolic link/)
    await expect(uploadFile(api, volume, { dir: "/evil", name: "x", size: 1, body: bytes("x"), overwrite: false })).rejects.toThrow(
      /symbolic link/
    )
    await expect(readTextFile(api, volume, "/evil/passwd")).rejects.toThrow(/symbolic link/)
    // ...but the link itself can be deleted (not its target).
    await deletePath(api, volume, "/evil")

    // At most one read-only and one read-write helper served all of that (the
    // read-only one may already be gone: its idle time is 5 s here)...
    const used = await helpers()
    expect(used.length).toBeLessThanOrEqual(2)
    expect(new Set(used.map((h) => h.Labels["gantry.helper.access"])).size).toBe(used.length)
    // ...and they are removed once idle.
    const deadline = Date.now() + 240_000
    while ((await helpers()).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2000))
    expect(await helpers()).toEqual([])
  }, SLOW)
})
