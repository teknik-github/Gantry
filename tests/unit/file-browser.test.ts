import { describe, expect, it } from "vitest"

import {
  entryOwner,
  entryTypeLabel,
  existingNames,
  followableLink,
  splitFilePath,
  uploadUrl,
  withoutNames,
} from "@/lib/files/browser"

const TYPES = { other: "other", hardlink: "hard link", folder: "folder", file: "file", symlink: "symlink" }

describe("file browser helpers", () => {
  it("shows owner names when known, else the ids", () => {
    expect(entryOwner({ uid: 0, gid: 0, user: "root", group: "root" })).toBe("root:root")
    expect(entryOwner({ uid: 1000, gid: 50 })).toBe("1000:50")
    expect(entryOwner({ uid: 1000, gid: 50, user: "app" })).toBe("app:50")
  })

  it("follows links relative to the folder, and absolute ones only in containers", () => {
    const container = { kind: "container", id: "abc" } as const
    const volume = { kind: "volume", name: "data" } as const
    expect(followableLink(container, "/etc", { type: "symlink", linkTarget: "../usr/lib" })).toBe("/usr/lib")
    expect(followableLink(container, "/etc", { type: "symlink", linkTarget: "/var/log" })).toBe("/var/log")
    expect(followableLink(volume, "/etc", { type: "symlink", linkTarget: "/var/log" })).toBeNull()
    expect(followableLink(volume, "/a", { type: "symlink", linkTarget: "b" })).toBe("/a/b")
    // ".." stops at the root.
    expect(followableLink(volume, "/", { type: "symlink", linkTarget: "../../x" })).toBe("/x")
    expect(followableLink(container, "/", { type: "file", linkTarget: "x" })).toBeNull()
    expect(followableLink(container, "/", { type: "symlink" })).toBeNull()
  })

  it("labels the entry type", () => {
    expect(entryTypeLabel({ type: "dir" }, TYPES)).toBe("folder")
    expect(entryTypeLabel({ type: "file" }, TYPES)).toBe("file")
    expect(entryTypeLabel({ type: "symlink" }, TYPES)).toBe("symlink")
    expect(entryTypeLabel({ type: "file", kind: "hardlink" }, TYPES)).toBe("hard link")
    expect(entryTypeLabel({ type: "other", kind: "fifo" }, TYPES)).toBe("fifo")
    expect(entryTypeLabel({ type: "other" }, TYPES)).toBe("other")
  })

  it("finds upload conflicts and leaves them out", () => {
    const files = [{ name: "a.txt" }, { name: "b.txt" }, { name: "c.txt" }]
    expect(existingNames(files, [{ name: "b.txt" }, { name: "c.txt" }, { name: "z" }])).toEqual(["b.txt", "c.txt"])
    expect(existingNames(files, undefined)).toEqual([])
    expect(withoutNames(files, ["b.txt", "c.txt"])).toEqual([{ name: "a.txt" }])
    expect(withoutNames(files, [])).toEqual(files)
  })

  it("splits a file path into folder and name", () => {
    expect(splitFilePath("/etc/hosts")).toEqual({ dir: "/etc", name: "hosts" })
    expect(splitFilePath("/hosts")).toEqual({ dir: "/", name: "hosts" })
    expect(splitFilePath("/a/b/c.conf")).toEqual({ dir: "/a/b", name: "c.conf" })
  })

  it("builds upload URLs", () => {
    expect(uploadUrl("container=abc", "/etc", "my file", {})).toBe("/api/uploads/files?container=abc&path=%2Fetc&name=my+file")
    expect(uploadUrl("volume=data", "/", "a", { overwrite: true, environmentId: 3 })).toBe(
      "/api/uploads/files?volume=data&path=%2F&name=a&overwrite=1&env=3"
    )
    expect(uploadUrl("volume=data", "/x", "a", { edit: true, overwrite: true, environmentId: 0 })).toBe(
      "/api/uploads/files?volume=data&path=%2Fx&name=a&mode=edit&overwrite=1&env=0"
    )
  })
})
