import { describe, expect, it } from "vitest"

import { diffOps, diffText, formatUnified } from "@/lib/kubernetes/diff"
import { editableObject, editHref, editableResource, parseEditedObject, resourceForKind, toYaml, updateBody } from "@/lib/kubernetes/edit"
import { eventAffectsPath } from "@/lib/live"

const lines = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n"

describe("diffText", () => {
  it("finds nothing between equal texts", () => {
    const d = diffText("a\nb\n", "a\nb\n")
    expect(d.hunks).toEqual([])
    expect(d.added + d.removed).toBe(0)
  })

  it("shows a changed line with three lines of context and line numbers", () => {
    const before = lines(10)
    const after = before.replace("line 5\n", "line five\n")
    const d = diffText(before, after)
    expect(d).toMatchObject({ added: 1, removed: 1, approximate: false })
    expect(d.hunks).toHaveLength(1)
    expect(formatUnified(d.hunks)).toBe(
      ["@@ -2,7 +2,7 @@", " line 2", " line 3", " line 4", "-line 5", "+line five", " line 6", " line 7", " line 8"].join("\n")
    )
    const removed = d.hunks[0].lines.find((l) => l.type === "remove")!
    const added = d.hunks[0].lines.find((l) => l.type === "add")!
    expect(removed.oldNo).toBe(5)
    expect(added.newNo).toBe(5)
  })

  it("splits distant changes into hunks and merges close ones", () => {
    const before = lines(40)
    const far = before.replace("line 3\n", "x\n").replace("line 30\n", "y\n")
    expect(diffText(before, far).hunks).toHaveLength(2)
    const near = before.replace("line 3\n", "x\n").replace("line 8\n", "y\n")
    expect(diffText(before, near).hunks).toHaveLength(1)
  })

  it("handles insertions and deletions at the edges and empty texts", () => {
    expect(formatUnified(diffText("b\n", "a\nb\n").hunks)).toBe("@@ -1,1 +1,2 @@\n+a\n b")
    expect(formatUnified(diffText("a\nb\n", "a\n").hunks)).toBe("@@ -1,2 +1,1 @@\n a\n-b")
    expect(diffText("", "a\n")).toMatchObject({ added: 1, removed: 0 })
    expect(diffText("a\n", "")).toMatchObject({ added: 0, removed: 1 })
  })

  it("produces a minimal edit script", () => {
    const { ops } = diffOps("a\nb\nc\na\nb\nb\na\n", "c\nb\na\nb\na\nc\n")
    // Myers' classic example: 5 edits (D = 5).
    expect(ops.filter((o) => o.type !== "=").length).toBe(5)
    // Applying the script gives the new text.
    expect(ops.filter((o) => o.type !== "-").map((o) => o.text)).toEqual(["c", "b", "a", "b", "a", "c"])
    expect(ops.filter((o) => o.type !== "+").map((o) => o.text)).toEqual(["a", "b", "c", "a", "b", "b", "a"])
  })

  it("falls back to replace-all when the texts differ too much", () => {
    const d = diffText(lines(50, "old"), lines(50, "new"), 3, 10)
    expect(d.approximate).toBe(true)
    expect(d).toMatchObject({ added: 50, removed: 50 })
  })
})

const LIVE = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: {
    name: "app",
    namespace: "apps",
    uid: "1234",
    resourceVersion: "4711",
    creationTimestamp: "2026-10-01T00:00:00Z",
    generation: 1,
    labels: { app: "web" },
    managedFields: [{ manager: "kubectl" }],
  },
  data: { greeting: "hello", "multi.txt": "a\nb\n" },
  status: { ignored: true },
}

const expected = { apiVersion: "v1", kind: "ConfigMap", namespace: "apps", name: "app" }

describe("edit YAML", () => {
  it("knows which kinds are editable", () => {
    expect(editableResource("configmaps")).toMatchObject({ kind: "ConfigMap", apiVersion: "v1" })
    expect(editableResource("secrets")).toMatchObject({ adminOnly: true })
    expect(editableResource("nodes")).toBeNull()
    expect(editableResource("constructor")).toBeNull()
    expect(resourceForKind("Deployment")).toBe("deployments")
    expect(editHref("ConfigMap", "apps", "a.b")).toBe("/kubernetes/edit/configmaps/apps/a.b")
    expect(editHref("Pod", "apps", "x")).toBeNull()
  })

  it("leaves status and server-maintained metadata out of the editor", () => {
    const obj = editableObject(LIVE)
    expect(obj.status).toBeUndefined()
    expect(obj.metadata).toEqual({ name: "app", namespace: "apps", labels: { app: "web" } })
    const yaml = toYaml(obj)
    expect(yaml).toContain("multi.txt: |")
    expect(yaml).not.toContain("managedFields")
    expect(yaml).not.toContain("4711")
  })

  it("parses an edit of the same object", () => {
    const res = parseEditedObject(toYaml(editableObject(LIVE)).replace("greeting: hello", "greeting: hola"), expected)
    expect(res.ok && (res.object.data as Record<string, string>).greeting).toBe("hola")
    // Without a namespace it is the object's own.
    expect(parseEditedObject("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\n", expected).ok).toBe(true)
  })

  it("refuses renames, moves, other kinds, several documents and invalid YAML", () => {
    const base = toYaml(editableObject(LIVE))
    const cases: [string, RegExp][] = [
      [base.replace("name: app", "name: other"), /metadata.name must stay app/],
      [base.replace("namespace: apps", "namespace: kube-system"), /namespace must stay apps/],
      [base.replace("kind: ConfigMap", "kind: Secret"), /kind must stay ConfigMap/],
      [base.replace("apiVersion: v1", "apiVersion: v2"), /apiVersion must stay v1/],
      [`${base}---\n${base}`, /exactly one object/],
      ["- a\n- b\n", /mapping/],
      ["data: [\n", /Invalid YAML/],
      ["", /empty/],
      ["apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app\ndata:\n  a: 1\n  a: 2\n", /Invalid YAML/],
    ]
    for (const [text, error] of cases) {
      const res = parseEditedObject(text, expected)
      expect(res.ok, text).toBe(false)
      if (!res.ok) expect(res.error).toMatch(error)
    }
  })

  it("sends the update with the version it was loaded at", () => {
    const body = updateBody({ apiVersion: "v1", kind: "ConfigMap", metadata: { name: "app", resourceVersion: "1", managedFields: [] } }, "apps", "4711")
    expect(body.metadata).toEqual({ name: "app", namespace: "apps", resourceVersion: "4711" })
  })

  it("diffs the live object against the edited one by their YAML", () => {
    const before = toYaml(editableObject(LIVE))
    const after = toYaml(editableObject({ ...LIVE, data: { ...LIVE.data, greeting: "hola" } }))
    const d = diffText(before, after)
    expect(d.removed).toBe(1)
    expect(d.added).toBe(1)
    expect(formatUnified(d.hunks)).toContain("-  greeting: hello\n+  greeting: hola")
  })
})

describe("live updates of the ConfigMaps & Secrets page", () => {
  it("refreshes for configmap and secret changes", () => {
    expect(eventAffectsPath({ type: "kubernetes", kind: "ConfigMap", action: "added", namespace: "a", name: "b" }, "/kubernetes/config")).toBe(true)
    expect(eventAffectsPath({ type: "kubernetes", kind: "Secret", action: "deleted", namespace: "a", name: "b" }, "/kubernetes/config")).toBe(true)
    expect(eventAffectsPath({ type: "kubernetes", kind: "Pod", action: "added" }, "/kubernetes/config")).toBe(false)
    // Helm keeps releases in Secrets.
    expect(eventAffectsPath({ type: "kubernetes", kind: "Secret", action: "added" }, "/kubernetes/helm")).toBe(true)
    // The editor is never refreshed under the user's edits.
    expect(eventAffectsPath({ type: "kubernetes", kind: "ConfigMap", action: "modified" }, "/kubernetes/edit/configmaps/a/b")).toBe(false)
  })
})
