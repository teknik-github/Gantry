import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { buffer } from "node:stream/consumers"
import { afterAll, describe, expect, it } from "vitest"

import {
  describePushError,
  interpretDockerMessage,
  isArchiveName,
  JsonLineParser,
  looksLikeArchive,
  MAX_TAGS,
  parseBuildArgs,
  parseBuildOptions,
  parseImageReference,
  parseLabels,
  parseTags,
  summarizeSource,
  validateContextPath,
  validateDockerfilePath,
  validateEditorSource,
  validateGitBuildSource,
  validateTarget,
} from "@/lib/image-build"
import { registryConfigHeader } from "@/lib/registry-config"
import { ContextError, directoryContext, editorContext, uploadGuard } from "@/lib/server/images/context"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gantry-test-b-unit-"))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe("image references", () => {
  it.each([
    ["alpine", "alpine:latest"],
    ["alpine:3", "alpine:3"],
    ["team/app:1.0", "team/app:1.0"],
    ["localhost:5000/gantry-test-b/app:v1", "localhost:5000/gantry-test-b/app:v1"],
    ["ghcr.io/org/app", "ghcr.io/org/app:latest"],
    ["registry.example.com:443/a/b/c:2_x-y.z", "registry.example.com:443/a/b/c:2_x-y.z"],
    ["my__app", "my__app:latest"],
    ["my--app:1", "my--app:1"],
  ])("%s → %s", (input, out) => {
    const r = parseImageReference(input)
    expect(r.ok && r.value.reference).toBe(out)
  })

  it("splits repository and tag after a registry port", () => {
    const r = parseImageReference("localhost:5000/app")
    expect(r.ok && r.value).toEqual({ repository: "localhost:5000/app", tag: "latest", reference: "localhost:5000/app:latest" })
  })

  it.each([
    ["", /Enter an image name/],
    ["App:1", /lowercase/],
    ["app:", /not a valid tag/],
    ["app:-x", /not a valid tag/],
    ["app@sha256:abc", /digest/],
    ["a//b", /empty path/],
    ["app/", /empty path/],
    ["-app", /not valid/],
    ["app..x", /not valid/],
    ["bad_host!:5000/app", /not a valid registry/],
    ["x".repeat(256), /too long/],
  ])("rejects %j", (input, message) => {
    const r = parseImageReference(input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(message)
  })

  it("parses tags one per line, comma or space separated, deduplicated", () => {
    expect(parseTags("a:1\nb, c:2  a:1\n\n")).toEqual({ ok: true, value: ["a:1", "b:latest", "c:2"] })
    expect(parseTags("  ").ok).toBe(false)
    expect(parseTags("ok:1\nBad:1")).toMatchObject({ ok: false, error: expect.stringContaining("Bad:1") })
    const many = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t:${i}`).join("\n")
    expect(parseTags(many)).toMatchObject({ ok: false, error: `At most ${MAX_TAGS} tags` })
  })
})

describe("build options", () => {
  it("parses build args and labels", () => {
    expect(parseBuildArgs("# comment\nGREETING=hi there\nEMPTY=\nX=a=b\n")).toEqual({
      ok: true,
      value: { GREETING: "hi there", EMPTY: "", X: "a=b" },
    })
    expect(parseBuildArgs("1BAD=x")).toMatchObject({ ok: false, error: expect.stringContaining("Line 1") })
    expect(parseBuildArgs("NOEQUALS")).toMatchObject({ ok: false, error: "Line 1: use KEY=value" })
    expect(parseBuildArgs(`V=${"x".repeat(5000)}`).ok).toBe(false)
    expect(parseLabels("org.opencontainers.image.source=https://x\ncom.example/a-b=1")).toEqual({
      ok: true,
      value: { "org.opencontainers.image.source": "https://x", "com.example/a-b": "1" },
    })
    expect(parseLabels("bad key=1").ok).toBe(false)
    const tooMany = Array.from({ length: 51 }, (_, i) => `K${i}=v`).join("\n")
    expect(parseBuildArgs(tooMany)).toMatchObject({ ok: false, error: "At most 50 build arguments" })
  })

  it("validates the target stage", () => {
    expect(validateTarget(" ")).toEqual({ ok: true, value: "" })
    expect(validateTarget("build-stage.1")).toEqual({ ok: true, value: "build-stage.1" })
    expect(validateTarget("bad stage").ok).toBe(false)
  })

  it("collects field errors for every invalid option", () => {
    const r = parseBuildOptions({ tags: "", buildArgs: "1=1", labels: "ok=1", target: "a b" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.fieldErrors).sort()).toEqual(["buildArgs", "tags", "target"])
  })

  it("only treats true as a flag", () => {
    const r = parseBuildOptions({ tags: "x", noCache: "true", pull: true, push: 1 })
    expect(r).toEqual({
      ok: true,
      value: { tags: ["x:latest"], buildArgs: {}, labels: {}, target: "", noCache: false, pull: true, push: false },
    })
  })
})

describe("build sources", () => {
  it.each([
    ["", "Dockerfile"],
    ["./docker/Dockerfile.prod", "docker/Dockerfile.prod"],
    ["sub/", "sub"],
  ])("Dockerfile path %j → %j", (input, out) => expect(validateDockerfilePath(input)).toEqual({ ok: true, value: out }))

  it.each(["../Dockerfile", "/etc/passwd", "a/../../b", "a\\b", ".git/config", "-f", "a b"])("refuses path %j", (input) =>
    expect(validateDockerfilePath(input).ok).toBe(false)
  )

  it("an empty context directory is the repository root", () => {
    expect(validateContextPath("")).toEqual({ ok: true, value: "" })
    expect(validateContextPath(".")).toEqual({ ok: true, value: "" })
    expect(validateContextPath("services/api/")).toEqual({ ok: true, value: "services/api" })
  })

  it("validates editor files", () => {
    expect(validateEditorSource({ dockerfile: "  " })).toMatchObject({ ok: false, fieldErrors: { dockerfile: ["The Dockerfile is empty"] } })
    const ok = validateEditorSource({
      dockerfile: "FROM alpine:3",
      files: [{ path: "./app/run.sh", content: "#!/bin/sh" }, { path: "", content: "" }],
    })
    expect(ok).toEqual({ ok: true, value: { kind: "editor", dockerfile: "FROM alpine:3", files: [{ path: "app/run.sh", content: "#!/bin/sh" }] } })
    const bad = (files: unknown) => validateEditorSource({ dockerfile: "FROM x", files })
    expect(bad([{ path: "../x", content: "" }])).toMatchObject({ ok: false, fieldErrors: { files: [expect.stringContaining("File 1")] } })
    expect(bad([{ path: "Dockerfile", content: "" }]).ok).toBe(false)
    expect(bad([{ path: "a", content: "1" }, { path: "a", content: "2" }]).ok).toBe(false)
    expect(bad([{ path: "a", content: "1" }, { path: "a/b", content: "2" }]).ok).toBe(false)
    expect(bad([{ path: "", content: "orphan content" }]).ok).toBe(false)
    expect(bad([{ path: "big", content: "x".repeat(1024 * 1024) }])).toMatchObject({ ok: false, fieldErrors: { files: [expect.stringContaining("upload an archive")] } })
    expect(bad(Array.from({ length: 21 }, (_, i) => ({ path: `f${i}`, content: "" }))).ok).toBe(false)
  })

  it("validates Git sources like Git stacks", () => {
    expect(validateGitBuildSource({ url: "https://example.com/o/r.git", ref: "", context: "app", dockerfile: "" })).toEqual({
      ok: true,
      value: { kind: "git", url: "https://example.com/o/r.git", ref: "main", context: "app", dockerfile: "Dockerfile" },
    })
    const r = validateGitBuildSource({ url: "http://127.0.0.1:9/r.git", ref: "--upload-pack=x", context: "../", dockerfile: "/x" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.fieldErrors).sort()).toEqual(["context", "gitDockerfile", "ref", "url"])
    expect(validateGitBuildSource({ url: "http://127.0.0.1:9/r.git" }, { allowHttpLoopback: true }).ok).toBe(true)
    expect(validateGitBuildSource({ url: "https://user:pw@example.com/r.git" }).ok).toBe(false)
  })

  it("summarizes sources without secrets", () => {
    expect(summarizeSource({ kind: "git", url: "https://example.com/r.git", ref: "v1", context: "app", dockerfile: "Dockerfile.prod" })).toBe(
      "Git https://example.com/r.git @ v1 (app, Dockerfile.prod)"
    )
    expect(summarizeSource({ kind: "editor", dockerfile: "FROM x", files: [{ path: "a", content: "" }] })).toBe("Dockerfile editor + 1 file(s)")
    expect(summarizeSource({ kind: "upload", filename: "ctx.tar.gz", dockerfile: "Dockerfile" })).toBe("Upload ctx.tar.gz")
  })

  it("recognizes archives by name and by content", () => {
    expect(isArchiveName("ctx.tar")).toBe(true)
    expect(isArchiveName("ctx.TGZ")).toBe(true)
    expect(isArchiveName("ctx.zip")).toBe(false)
    expect(looksLikeArchive(Uint8Array.from([0x1f, 0x8b, 8]))).toBe(true)
    expect(looksLikeArchive(editorContext({ kind: "editor", dockerfile: "FROM x", files: [] }))).toBe(true)
    expect(looksLikeArchive(new TextEncoder().encode("PK\u0003\u0004 not a tar".padEnd(600)))).toBe(false)
  })
})

describe("Docker's JSON stream", () => {
  it("reassembles messages split across chunks", () => {
    const p = new JsonLineParser()
    expect(p.push('{"stream":"Step 1/2 : FROM al')).toEqual([])
    expect(p.push('pine:3"}\r\n{"stream":"\\n"}\n{"aux":{"ID":"sha256:ab')).toEqual([{ stream: "Step 1/2 : FROM alpine:3" }, { stream: "\n" }])
    expect(p.push('c"}}')).toEqual([])
    expect(p.end()).toEqual([{ aux: { ID: "sha256:abc" } }])
    expect(p.end()).toEqual([])
  })

  it("keeps lines that aren't JSON and caps runaway lines", () => {
    const p = new JsonLineParser(10)
    expect(p.push("plain text\n")).toEqual([{ raw: "plain text" }])
    expect(p.push("0123456789abc")).toEqual([{ raw: "0123456789abc" }])
  })

  it.each([
    [{ stream: "Step 2/3 : RUN echo hi\n" }, { kind: "log", text: "Step 2/3 : RUN echo hi\n" }],
    [{ stream: "" }, { kind: "ignore" }],
    [{ aux: { ID: "sha256:1234" } }, { kind: "image", id: "sha256:1234" }],
    [{ aux: { Tag: "1", Digest: "sha256:d", Size: 1 } }, { kind: "pushed", tag: "1", digest: "sha256:d" }],
    [
      { errorDetail: { code: 1, message: "The command '/bin/sh -c exit 3' returned a non-zero code: 3" }, error: "x" },
      { kind: "error", message: "The command '/bin/sh -c exit 3' returned a non-zero code: 3" },
    ],
    [{ error: "only error" }, { kind: "error", message: "only error" }],
    [{ status: "Pulling from library/alpine", id: "3" }, { kind: "log", text: "3: Pulling from library/alpine\n" }],
    [{ status: "The push refers to repository [localhost:5000/a]" }, { kind: "log", text: "The push refers to repository [localhost:5000/a]\n" }],
    [
      { status: "Pushing", id: "abc", progressDetail: { current: 1, total: 2 }, progress: "[==>  ]" },
      { kind: "progress", progress: { id: "abc", status: "Pushing", progress: "[==>  ]" } },
    ],
    [{ status: "Pushed", id: "abc", progressDetail: {} }, { kind: "log", text: "abc: Pushed\n" }],
    [{ raw: "garbage" }, { kind: "log", text: "garbage\n" }],
    [null, { kind: "ignore" }],
    [{ aux: { Other: 1 } }, { kind: "ignore" }],
  ])("%j", (input, out) => expect(interpretDockerMessage(input)).toEqual(out))
})

describe("push errors", () => {
  const ctx = { reference: "localhost:5000/a:1", registry: "localhost:5000" }

  it("points to Registries when no login is stored", () => {
    const r = describePushError("no basic auth credentials", ctx)
    expect(r.hint).toBe("registries")
    expect(r.message).toMatch(/none is configured.*Registries/)
  })

  it("names the stored login the registry refused", () => {
    const r = describePushError("unauthorized: authentication required", { ...ctx, username: "ci" })
    expect(r).toEqual({ message: expect.stringContaining("refused the push of localhost:5000/a:1 for ci"), hint: "registries" })
    expect(describePushError("denied: requested access to the resource is denied", ctx).hint).toBe("registries")
  })

  it("explains other failures", () => {
    expect(describePushError("An image does not exist locally with the tag: x", ctx).message).toMatch(/doesn't exist/)
    expect(describePushError("http: server gave HTTP response to HTTPS client", ctx).message).toMatch(/insecure-registries/)
    expect(describePushError("dial tcp 127.0.0.1:5000: connect: connection refused", ctx).message).toMatch(/can't reach/)
    expect(describePushError("something else", ctx)).toEqual({ message: "something else" })
  })
})

describe("X-Registry-Config", () => {
  const decode = (header: string) => JSON.parse(Buffer.from(header.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))

  it("maps every login by registry, Docker Hub under its index URL", () => {
    const header = registryConfigHeader([
      { address: "localhost:5000", username: "u", password: "p" },
      { address: "docker.io", username: "hub", password: "s3cr?t>" },
    ])
    expect(decode(header)).toEqual({
      "localhost:5000": { username: "u", password: "p", serveraddress: "localhost:5000" },
      "https://index.docker.io/v1/": { username: "hub", password: "s3cr?t>", serveraddress: "https://index.docker.io/v1/" },
    })
  })

  it("is base64url with padding (Docker drops unpadded values)", () => {
    for (let n = 0; n < 6; n++) {
      const header = registryConfigHeader([{ address: "r.example.com", username: "u".repeat(n + 1), password: "p?>~" }])
      expect(header).toMatch(/^[A-Za-z0-9_-]+={0,2}$/)
      expect(header.length % 4).toBe(0)
    }
    expect(registryConfigHeader([])).toBe("e30=")
  })
})

describe("build contexts", () => {
  const list = (file: string) => execFileSync("tar", ["-tvf", file], { encoding: "utf8" })

  it("writes the editor's files as a tar with folders", () => {
    const tar = editorContext({
      kind: "editor",
      dockerfile: "FROM alpine:3\nCOPY . /src\n",
      files: [
        { path: "app/run.sh", content: "#!/bin/sh\necho hi\n" },
        { path: "app/conf/settings.json", content: '{"a":1}' },
        { path: `deep/${"x".repeat(120)}.txt`, content: "long name" },
      ],
    })
    const file = path.join(tmp, "editor.tar")
    fs.writeFileSync(file, tar)
    const out = list(file)
    expect(out).toMatch(/-rw-r--r-- .* Dockerfile/)
    expect(out).toMatch(/drwxr-xr-x .* app\//)
    expect(out).toMatch(/-rwxr-xr-x .* app\/run\.sh/)
    expect(out).toContain("app/conf/settings.json")
    expect(out).toContain(`deep/${"x".repeat(120)}.txt`)
    const extracted = path.join(tmp, "editor-out")
    fs.mkdirSync(extracted)
    execFileSync("tar", ["-xf", file, "-C", extracted])
    expect(fs.readFileSync(path.join(extracted, "app/conf/settings.json"), "utf8")).toBe('{"a":1}')
    expect(fs.readFileSync(path.join(extracted, `deep/${"x".repeat(120)}.txt`), "utf8")).toBe("long name")
  })

  it("streams a directory: files, modes and symlinks; no .git", async () => {
    const dir = path.join(tmp, "repo")
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".git", "config"), "secret")
    fs.mkdirSync(path.join(dir, "src", "ünïcode"), { recursive: true })
    fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM alpine:3\n")
    fs.writeFileSync(path.join(dir, "src", "ünïcode", "file.txt"), "x".repeat(1500))
    fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\n", { mode: 0o755 })
    fs.symlinkSync("src/ünïcode/file.txt", path.join(dir, "link"))
    fs.symlinkSync(`../${"y".repeat(150)}`, path.join(dir, "longlink"))

    const tar = await buffer(directoryContext(dir, { maxBytes: 1024 * 1024 }))
    const file = path.join(tmp, "dir.tar")
    fs.writeFileSync(file, tar)
    const out = list(file)
    expect(out).not.toContain(".git")
    expect(out).toMatch(/-rwxr-xr-x .* run\.sh/)
    expect(out).toContain("link -> src/ünïcode/file.txt")
    expect(out).toContain(`longlink -> ../${"y".repeat(150)}`)
    const extracted = path.join(tmp, "dir-out")
    fs.mkdirSync(extracted)
    execFileSync("tar", ["-xf", file, "-C", extracted])
    expect(fs.readFileSync(path.join(extracted, "src", "ünïcode", "file.txt"), "utf8")).toHaveLength(1500)
  })

  it("stops a directory past the size limit", async () => {
    const dir = path.join(tmp, "big")
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, "blob"), Buffer.alloc(8192))
    await expect(buffer(directoryContext(dir, { maxBytes: 4096 }))).rejects.toThrow(ContextError)
  })

  it("passes archives through the upload guard and refuses the rest", async () => {
    const tar = editorContext({ kind: "editor", dockerfile: "FROM x", files: [] })
    // Tiny chunks: the guard has to wait for the tar header.
    const chunks = Array.from({ length: Math.ceil(tar.length / 100) }, (_, i) => tar.subarray(i * 100, (i + 1) * 100))
    expect(Buffer.compare(await buffer(Readable.from(chunks).pipe(uploadGuard(1024 * 1024))), tar)).toBe(0)
    await expect(buffer(Readable.from([Buffer.from("not an archive at all".padEnd(1000))]).pipe(uploadGuard(1 << 20)))).rejects.toThrow(
      /not a tar archive/
    )
    await expect(buffer(Readable.from([tar]).pipe(uploadGuard(1000)))).rejects.toThrow(/larger than/)
    await expect(buffer(Readable.from([Buffer.from("tiny")]).pipe(uploadGuard(1000)))).rejects.toThrow(/not a tar/)
    await expect(buffer(Readable.from([]).pipe(uploadGuard(1000)))).rejects.toThrow(/empty/)
  })
})
