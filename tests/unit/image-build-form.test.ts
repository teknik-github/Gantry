import { describe, expect, it } from "vitest"

import { BUILD_OPTIONS_HEADER, buildFormRequest, MAX_OPTIONS_HEADER, type BuildFormState } from "@/lib/image-build"

const fields: Record<string, string> = {
  tags: "app:1",
  buildArgs: "A=1",
  labels: "",
  target: "",
  dockerfile: "FROM alpine:3\n",
  uploadDockerfile: "build/Dockerfile",
  url: "https://example.com/repo.git",
  ref: "main",
  context: "app",
  gitDockerfile: "Dockerfile",
  username: "ci",
  token: "secret",
}
const field = (key: string) => fields[key] ?? ""

const base: BuildFormState = {
  kind: "editor",
  files: [{ path: "a.txt", content: "a" }],
  noCache: true,
  pull: false,
  push: true,
  archive: null,
  environmentId: 7,
}

const options = { tags: "app:1", buildArgs: "A=1", labels: "", target: "", noCache: true, pull: false, push: true }

describe("build form request", () => {
  it("sends an editor build as JSON", () => {
    const r = buildFormRequest(base, field)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.url).toBe("/api/images/build")
    expect(r.init.method).toBe("POST")
    expect(r.init.headers).toEqual({ "Content-Type": "application/json" })
    expect(JSON.parse(r.init.body as string)).toEqual({
      environmentId: 7,
      source: { kind: "editor", dockerfile: "FROM alpine:3\n", files: [{ path: "a.txt", content: "a" }] },
      options,
    })
  })

  it("sends a Git build with its login", () => {
    const r = buildFormRequest({ ...base, kind: "git" }, field)
    if (!r.ok) throw new Error("expected a request")
    expect(JSON.parse(r.init.body as string).source).toEqual({
      kind: "git",
      url: "https://example.com/repo.git",
      ref: "main",
      context: "app",
      dockerfile: "Dockerfile",
      username: "ci",
      token: "secret",
    })
  })

  it("sends an archive as the body, the rest in a header", () => {
    const archive = new File(["x"], "context.tar.gz")
    const r = buildFormRequest({ ...base, kind: "upload", archive }, field)
    if (!r.ok) throw new Error("expected a request")
    expect(r.url).toBe("/api/images/build/upload")
    expect(r.init.body).toBe(archive)
    const headers = r.init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/octet-stream")
    expect(JSON.parse(decodeURIComponent(headers[BUILD_OPTIONS_HEADER]))).toEqual({
      environmentId: 7,
      filename: "context.tar.gz",
      dockerfile: "build/Dockerfile",
      options,
    })
  })

  it("needs an archive with a known extension", () => {
    expect(buildFormRequest({ ...base, kind: "upload" }, field)).toEqual({ ok: false, error: "archive" })
    expect(buildFormRequest({ ...base, kind: "upload", archive: new File(["x"], "context.zip") }, field)).toEqual({
      ok: false,
      error: "archive",
    })
  })

  it("refuses options too long for the header", () => {
    const long = (key: string) => (key === "labels" ? `L=${"x".repeat(MAX_OPTIONS_HEADER)}` : field(key))
    const archive = new File(["x"], "context.tar")
    expect(buildFormRequest({ ...base, kind: "upload", archive }, long)).toEqual({ ok: false, error: "optionsTooLong" })
    // JSON bodies have no such limit here (the server checks their size).
    expect(buildFormRequest(base, long).ok).toBe(true)
  })
})
